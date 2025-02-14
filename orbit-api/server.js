require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const mongoose = require('mongoose');
const session = require('express-session');
const redis = require('redis');
const redisClient = redis.createClient();
const redisStore = require('connect-redis')(session);

const csrf = require('csurf');
const cookieParser = require('cookie-parser');
const dashboardData = require('./data/dashboard');
const User = require('./data/User');
const InventoryItem = require('./data/InventoryItem');

const { hashPassword, verifyPassword } = require('./util');

const app = express();


redisClient.on('error', function (err) {
  console.log('could not establish a connection with redis. ' + err);
});
redisClient.on('connect', function (err) {
  console.log('connected to redis successfully');
});

app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(cookieParser());

app.use(
  session({
    store: new redisStore({ host: 'localhost', port: 6379, client: redisClient, ttl: process.env.REDIS_SESSION_AGE }),
    name:'_academystore',
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: true,
      secure:
        process.env.NODE_ENV === 'production'
          ? true
          : false,
      maxAge: parseInt(process.env.SESSION_MAX_AGE)
    }
  })
);

const csrfProtection = csrf({
  cookie: true
});
app.use(csrfProtection);

app.get('/api/csrf-token', (req, res) => {
  res.json({ csrfToken: req.csrfToken() });
});

app.use((req,res,next) => {
  console.log(req.session)
  console.log(req.session);
  // console.log(req.session.user._id);
  const sessionKey = `sess:${req.session.id}`;
  redisClient.get(sessionKey, (err, data) => {
    console.log('session data in redis:', data)
  });

  
  next()
})

app.post('/api/authenticate', async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({
      email
    }).lean();

    if (!user) {
      return res.status(403).json({
        message: 'Wrong email or password.'
      });
    }

    const passwordValid = await verifyPassword(
      password,
      user.password
    );

    if (passwordValid) {
      const {
        _id,
        firstName,
        lastName,
        email,
        role
      } = user;

      const userInfo = {
        _id,
        firstName,
        lastName,
        email,
        role
      };

      req.session.user = userInfo;
      redisClient.sadd(`sessions:${userInfo._id}`,"sess:" + req.session.id);

      res.json({
        message: 'Authentication successful!',
        userInfo
      });
    } else {
      res.status(403).json({
        message: 'Wrong email or password.'
      });
    }
  } catch (err) {
    return res
      .status(400)
      .json({ message: 'Something went wrong.' });
  }
});

app.post('/api/signup', async (req, res) => {
  try {
    const { email, firstName, lastName } = req.body;

    const hashedPassword = await hashPassword(
      req.body.password
    );

    const userData = {
      email: email.toLowerCase(),
      firstName,
      lastName,
      password: hashedPassword,
      role: 'admin'
    };

    const existingEmail = await User.findOne({
      email: userData.email
    }).lean();

    if (existingEmail) {
      return res
        .status(400)
        .json({ message: 'Email already exists' });
    }

    const newUser = new User(userData);
    const savedUser = await newUser.save();

    if (savedUser) {
      const {
        _id,
        firstName,
        lastName,
        email,
        role
      } = savedUser;

      const userInfo = {
        _id,
        firstName,
        lastName,
        email,
        role
      };

      req.session.user = userInfo;

      res.json({
        message: 'User created!',
        userInfo
      });
    } else {
      return res.status(400).json({
        message: 'There was a problem creating your account'
      });
    }
  } catch (err) {
    return res.status(400).json({
      message: 'There was a problem creating your account'
    });
  }
});

app.post('/api/logout', (req, res) => {
  
    redisClient.smembers(`sessions:${req.session.user._id}`, function(err, sessionIds) {
    if (err) {
      return res.status(400).json({
        message: 'There was a problem logging out'
      });
    }
    if(sessionIds.length > 0){
       // Delete all sessions for a user
      redisClient.del.apply(redisClient, sessionIds);
    }
  });

  setTimeout(() => {
    redisClient.del(`sessions:${req.session.user._id}`);
    req.session.destroy(err => {
      if (err) {
        return res.status(400).json({
          message: 'There was a problem logging out'
        });
      }
      res.json({ message: 'Log out successful' });
    });
  },200);
});

const requireAuth = (req, res, next) => {
  const { user } = req.session;
  if (!user) {
    return res
      .status(401)
      .json({ message: 'Unauthorized' });
  }
  next();
};

const requireAdmin = (req, res, next) => {
  const { user } = req.session;
  if (user.role !== 'admin') {
    return res
      .status(401)
      .json({ message: 'Insufficient role' });
  }
  next();
};

app.get('/api/user-info', (req, res) => {
  const { user } = req.session;
  if (!user) {
    return res
      .status(401)
      .json({ message: 'Unauthorized' });
  }
  setTimeout(() => {
    res.json({ user });
  }, 1000);
});

app.get('/api/dashboard-data', requireAuth, (req, res) =>
  res.json(dashboardData)
);

app.patch('/api/user-role', async (req, res) => {
  try {
    const { role } = req.body;
    const { user } = req.session;
    const allowedRoles = ['user', 'admin'];

    if (!allowedRoles.includes(role)) {
      return res
        .status(400)
        .json({ message: 'Role not allowed' });
    }
    await User.findOneAndUpdate(
      { _id: user._id },
      { role }
    );

    req.session.user.role = role;
    res.json({
      message: 'User role updated.',
      user: req.session.user
    });
  } catch (err) {
    return res.status(400).json({ error: err });
  }
});

app.get(
  '/api/inventory',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const { user } = req.session;
      const inventoryItems = await InventoryItem.find({
        user: user._id
      });
      res.json(inventoryItems);
    } catch (err) {
      return res.status(400).json({ error: err });
    }
  }
);

app.post(
  '/api/inventory',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const { user } = req.session;
      const input = Object.assign({}, req.body, {
        user: user._id
      });
      const inventoryItem = new InventoryItem(input);
      await inventoryItem.save();
      res.status(201).json({
        message: 'Inventory item created!',
        inventoryItem
      });
    } catch (err) {
      return res.status(400).json({
        message: 'There was a problem creating the item'
      });
    }
  }
);

app.delete(
  '/api/inventory/:id',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const { user } = req.session;
      const deletedItem = await InventoryItem.findOneAndDelete(
        { _id: req.params.id, user: user._id }
      );
      res.status(201).json({
        message: 'Inventory item deleted!',
        deletedItem
      });
    } catch (err) {
      return res.status(400).json({
        message: 'There was a problem deleting the item.'
      });
    }
  }
);

app.get('/api/users', requireAuth, async (req, res) => {
  try {
    const users = await User.find()
      .lean()
      .select('_id firstName lastName avatar bio');

    res.json({
      users
    });
  } catch (err) {
    return res.status(400).json({
      message: 'There was a problem getting the users'
    });
  }
});

app.get('/api/bio', requireAuth, async (req, res) => {
  try {
    const { user } = req.session;
    const authenticatedUser = await User.findOne({
      _id: user._id
    })
      .lean()
      .select('bio');

    res.json({
      bio: authenticatedUser.bio
    });
  } catch (err) {
    return res.status(400).json({
      message: 'There was a problem updating your bio'
    });
  }
});

app.patch('/api/bio', requireAuth, async (req, res) => {
  try {
    const { user } = req.session;
    const { bio } = req.body;
    const updatedUser = await User.findOneAndUpdate(
      {
        _id: user._id
      },
      {
        bio
      },
      {
        new: true
      }
    );

    res.json({
      message: 'Bio updated!',
      bio: updatedUser.bio
    });
  } catch (err) {
    return res.status(400).json({
      message: 'There was a problem updating your bio'
    });
  }
});

async function connect() {
  try {
    mongoose.Promise = global.Promise;
    await mongoose.connect(process.env.ATLAS_URL, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      useFindAndModify: false
    });
  } catch (err) {
    console.log('Mongoose error', err);
  }
  app.listen(3001);
  console.log('API listening on localhost:3001');
}

connect();
