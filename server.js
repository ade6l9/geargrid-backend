const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();

//-----------------------FOR UPLOADS FOLDER-----------------------//
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use(express.json({limit: '10mb'}));
app.use(cors({
  origin: 'http://localhost:3000', 
  credentials: true, 
}));
app.use(bodyParser.json());
app.use(cookieParser());

//create a connection pool to the MySQL database
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// console.log('DB_HOST:', process.env.DB_HOST);
// console.log('DB_USER:', process.env.DB_USER);
// console.log('DB_NAME:', process.env.DB_NAME);

pool.getConnection()
  .then(connection => {
    console.log('Database connected successfully!');
    connection.release();
  })
  .catch(err => {
    console.error('Database connection failed:', err);
    process.exit(1);
});

const authenticateToken = (req, res, next) => {
  const token = req.cookies.token;

  if (!token) return res.status(401).json({ success: false, message: 'Token required' });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ success: false, message: 'Invalid or expired token' });
    req.user = user;
    next();
  });
};

app.get('/api/events', authenticateToken, async (req, res) => {
  try {
    const [events] = await pool.execute('SELECT * FROM Events');
    res.json({ success: true, events });
  } catch (error) {
    console.error('Error fetching events:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch events' });
  }
});

app.post('/api/check-registration', async (req, res) => {
  try {
    const { eventId, email } = req.body;
    
    const [registrations] = await pool.execute(
      'SELECT * FROM event_registrations WHERE event_id = ? AND email = ?',
      [eventId, email]
    );

    res.json({ 
      registered: registrations.length > 0,
      message: registrations.length > 0 
        ? 'This email is already registered for this event' 
        : ''
    });
  } catch (error) {
    console.error('Check registration error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to check registration status' 
    });
  }
});

app.post('/api/register-event', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const { firstName, lastName, email, phone, eventId, cars, userId } = req.body;

    if (!userId) {
      return res.status(400).json({ success: false, message: 'User ID is missing. Cannot complete registration.' });
    }

    const registrantName = `${firstName || ''} ${lastName || ''}`.trim();

    const [registrationResult] = await connection.execute(
      'INSERT INTO event_registrations (event_id, user_id, name, email, phone) VALUES (?, ?, ?, ?, ?)',
      [eventId, userId, registrantName, email, phone] 
    );
    const registrationId = registrationResult.insertId;

    if (!registrationId) {
      throw new Error('Failed to create registration entry.');
    }

    if (cars && cars.length > 0) {
      for (const car of cars) {
        await connection.execute(
          'INSERT INTO registered_cars (registration_id, make, model, year, color, mileage, modifications) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [registrationId, car.make, car.model, car.year, car.color, car.mileage, car.modified]
        );
      }
    }

    await connection.commit();
    res.json({ success: true, message: 'Registration successful!' });

  } catch (error) {
    if (connection) await connection.rollback();
    console.error('Registration error:', error);

    let errorMessage = 'Registration failed due to a server error.';
    if (error.code === 'ER_DUP_ENTRY') {
      if (error.message && error.message.includes('event_registrations.event_id_email_unique')) {
        errorMessage = 'This email is already registered for this event.';
      } else {
        errorMessage = 'A duplicate entry occurred. Please check your input.';
      }
    } else if (error.message && error.message.includes("Table 'registered_cars' doesn't exist")) {
        errorMessage = "Registration failed: The 'registered_cars' table is missing on the server.";
    } else if (error.message && error.message.includes("Unknown column")) {
        errorMessage = `Registration failed: There's a mismatch in table columns. Please check server logs.`;
    }
    
    res.status(500).json({
      success: false,
      message: errorMessage
    });
  } finally {
    if (connection) connection.release();
  }
});

app.get('/api/get-registration-details', authenticateToken, async (req, res) => {
  const { eventId } = req.query;
  const userId = req.user.id;

  if (!eventId) {
    return res.status(400).json({ success: false, message: 'Event ID is required.' });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    const [registrations] = await connection.execute(
      'SELECT * FROM event_registrations WHERE event_id = ? AND user_id = ?',
      [eventId, userId]
    );

    if (registrations.length === 0) {
      return res.status(404).json({ success: false, message: 'No registration found for this event and user.' });
    }

    const registration = registrations[0];
    const registrationId = registration.id;

    const [cars] = await connection.execute(
      'SELECT * FROM registered_cars WHERE registration_id = ?',
      [registrationId]
    );

    const nameParts = registration.name ? registration.name.split(' ') : ['', ''];
    const firstName = nameParts[0];
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';

    res.json({
      success: true,
      registrationDetails: {
        ...registration,
        firstName,
        lastName,
        cars: cars.map(car => ({
          id: car.id,
          make: car.make,
          model: car.model,
          year: car.year,
          color: car.color,
          mileage: car.mileage,
          modified: car.modifications,
        }))
      }
    });
  } catch (error) {
    console.error('Error fetching registration details:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch registration details.' });
  } finally {
    if (connection) connection.release();
  }
});

app.put('/api/update-event-registration/:registrationId', authenticateToken, async (req, res) => {
  const { registrationId } = req.params;
  const userId = req.user.id; 
  const { firstName, lastName, email, phone, cars } = req.body; 

  if (!registrationId) {
    return res.status(400).json({ success: false, message: 'Registration ID is required.' });
  }
  if (!firstName || !lastName || !email || !phone) {
    return res.status(400).json({ success: false, message: 'First name, last name, email, and phone are required.' });
  }
  if (!Array.isArray(cars)) {
    return res.status(400).json({ success: false, message: 'Cars must be an array.' });
  }

  let connection; 
  try {
    connection = await pool.getConnection(); 
    await connection.beginTransaction();

    const [existingRegistrations] = await connection.execute(
      'SELECT user_id FROM event_registrations WHERE id = ?',
      [registrationId]
    );

    if (existingRegistrations.length === 0) {
      await connection.rollback(); 
      return res.status(404).json({ success: false, message: 'Registration not found.' });
    }

    if (existingRegistrations[0].user_id !== userId) {
      await connection.rollback(); 
      return res.status(403).json({ success: false, message: 'You are not authorized to update this registration.' });
    }

    const registrantName = `${firstName} ${lastName}`.trim();
    await connection.execute(
      'UPDATE event_registrations SET name = ?, email = ?, phone = ? WHERE id = ?',
      [registrantName, email, phone, registrationId]
    );

    await connection.execute(
      'DELETE FROM registered_cars WHERE registration_id = ?',
      [registrationId]
    );

    if (cars && cars.length > 0) {
      for (const car of cars) {
        if (!car.make || !car.model || !car.year) {
            console.warn('Skipping car with missing make/model/year during update:', car);
            continue; 
        }
        await connection.execute(
          'INSERT INTO registered_cars (registration_id, make, model, year, color, mileage, modifications) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [registrationId, car.make, car.model, car.year, car.color, car.mileage, car.modified]
        );
      }
    }

    await connection.commit();
    res.json({ success: true, message: 'Registration updated successfully!' });

  } catch (error) {
    if (connection) await connection.rollback(); 
    console.error('Update registration error:', error);
    res.status(500).json({ success: false, message: 'Failed to update registration.' });
  } finally {
    if (connection) connection.release(); 
  }
});

app.get('/api/businesses', async (req, res) => {
  try {
    const [businesses] = await pool.execute('SELECT * FROM businesses');
    res.json({ success: true, businesses });
  } catch (error) {
    console.error('Error fetching businesses:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch businesses' });
  }
});

app.get('/api/businesses/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const [businesses] = await pool.execute('SELECT * FROM businesses WHERE name = ?', [name]);

    if (businesses.length === 0) {
      return res.status(404).json({ success: false, message: 'Business not found' });
    }

    res.json({ success: true, business: businesses[0] });
  } catch (error) {
    console.error('Error fetching business:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch business' });
  }
});

app.get('/api/businesses/:businessId/reviews', async (req, res) => {
  try {
    const { businessId } = req.params;
    const [reviews] = await pool.execute(
      `SELECT br.*, u.username 
      FROM business_reviews br 
      JOIN users u ON br.user_id = u.id 
      WHERE br.business_id = ? 
      ORDER BY br.create_time DESC`,
      [businessId]
    );
    res.json({ success: true, reviews });
  } catch (error) {
    console.error('Error fetching reviews:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch reviews' });
  }
});

app.post('/api/businesses/:businessId/reviews', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { userId, rating, comment } = req.body;

    if (!userId || !rating) {
      return res.status(400).json({ success: false, message: 'User ID and rating are required.' });
    }
    if (rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, message: 'Rating must be between 1 and 5.' });
    }

    const [existingReviews] = await pool.execute(
      'SELECT id FROM business_reviews WHERE business_id = ? AND user_id = ?',
      [businessId, userId]
    );

    if (existingReviews.length > 0) {
      return res.status(409).json({ success: false, message: 'You have already reviewed this business.' });
    }

    const [result] = await pool.execute(
      'INSERT INTO business_reviews (business_id, user_id, rating, comment) VALUES (?, ?, ?, ?)',
      [businessId, userId, rating, comment || null]
    );
    const [newReview] = await pool.execute(
        `SELECT br.*, u.username 
         FROM business_reviews br
         JOIN users u ON br.user_id = u.id 
         WHERE br.id = ?`, 
        [result.insertId]
    );
    res.status(201).json({ success: true, message: 'Review submitted successfully.', review: newReview[0] });
  } catch (error) {
    console.error('Error submitting review:', error);
    res.status(500).json({ success: false, message: 'Failed to submit review.' });
  }
});

app.put('/api/reviews/:reviewId', async (req, res) => {
  try {
    const { reviewId } = req.params;
    const { userId, rating, comment } = req.body;

    if (!userId || !rating) {
      return res.status(400).json({ success: false, message: 'User ID and rating are required for update.' });
    }
    if (rating < 1 || rating > 5) {
        return res.status(400).json({ success: false, message: 'Rating must be between 1 and 5.' });
    }

    const [reviews] = await pool.execute('SELECT user_id FROM business_reviews WHERE id = ?', [reviewId]);
    if (reviews.length === 0) {
      return res.status(404).json({ success: false, message: 'Review not found.' });
    }
    if (reviews[0].user_id !== userId) {
      return res.status(403).json({ success: false, message: 'You are not authorized to edit this review.' });
    }

    await pool.execute(
      'UPDATE business_reviews SET rating = ?, comment = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [rating, comment || null, reviewId]
    );
    const [updatedReview] = await pool.execute(
        `SELECT br.*, u.username 
         FROM business_reviews br
         JOIN users u ON br.user_id = u.id 
         WHERE br.id = ?`, 
        [reviewId]
    );
    res.json({ success: true, message: 'Review updated successfully.', review: updatedReview[0] });
  } catch (error) {
    console.error('Error updating review:', error);
    res.status(500).json({ success: false, message: 'Failed to update review.' });
  }
});

//endpoint for signup
app.post('/api/signup', async (req, res) => {
  try {
    console.log('Received signup request:', req.body);
    console.log(`${req.body.username}, ${req.body.email}, ${req.body.password}`)

    const hashedPassword = await bcrypt.hash(req.body.password, 10);
    console.log('Hashed password:', hashedPassword);

    if (!hashedPassword) {
      throw new Error("Hashed password is undefined");
    }
    
    //insert into database
    const [result] = await pool.execute(
      'INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)',
      [req.body.username, req.body.email, hashedPassword, req.body.username]
    );

    console.log('User created successfully:', result);
    res.status(201).json({ success: true, message: 'User created successfully' });
  } catch (error) {
    console.error('Error during signup:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ success: false, message: 'Username or email already exists' });
    }
    res.status(500).json({ success: false, message: 'Registration failed' });
  }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
  });
  res.json({ success: true, message: 'Logged out successfully' });
});

const PORT = process.env.SERVER_PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

//endpoint for Logging in a user
app.post('/api/login', async (req, res) => {
  try {
    console.log('Received login request:', req.body); 
    const { email, password } = req.body;
    
    //find the user
    const [users] = await pool.execute(
      'SELECT * FROM users WHERE email = ?',
      [email]
    );
    
    if (users.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    
    const user = users[0];
    console.log('Retrieved user:', user);
    
    // verify password
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    
    const token = jwt.sign(
      { id: user.id, username: user.username, displayName: user.display_name },
      process.env.JWT_SECRET,
      { expiresIn: '1h' } //expiration time
    );

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 3600000, // 1 hour 
      sameSite: 'Lax', //'Strict', 
    });

    res.json({ 
      success: true, 
      username: user.username, 
      userId: user.id, 
      email: user.email,
      displayName: user.display_name, 
      avatarUrl: user.avatar_url 
    });
  } catch (error) {
    console.error('Error during login:', error);
    res.status(500).json({ success: false, message: 'Login failed' });
  }
});

app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  console.log(`[SEARCH API] Received raw query: "${q}"`);

  if (!q || q.trim() === "") {
    console.log("[SEARCH API] Query is empty or whitespace, returning empty results.");
    return res.json({ success: true, users: [], builds: [] });
  }

  const searchTerm = q.trim();
  const sqlSearchQuery = `%${searchTerm}%`;
  console.log(`[SEARCH API] Processed SQL search query: "${sqlSearchQuery}"`);

  try {
    console.log(`[SEARCH API] Executing user search for: ${sqlSearchQuery}`);
    const [userResults] = await pool.execute(
      `SELECT id, username, display_name, avatar_url 
       FROM users 
       WHERE username LIKE ? OR display_name LIKE ?`,
      [sqlSearchQuery, sqlSearchQuery]
    );
    console.log("[SEARCH API] Raw user results from DB:", JSON.stringify(userResults, null, 2));

    console.log(`[SEARCH API] Executing build search for: ${sqlSearchQuery}`);
    const [buildResults] = await pool.execute(
      `SELECT b.id, b.car_name, b.cover_image, b.user_id, 
              u.username AS owner_username, u.display_name AS owner_display_name
       FROM builds b
       JOIN users u ON b.user_id = u.id
       WHERE b.car_name LIKE ?`,
      [sqlSearchQuery]
    );
    

    res.json({ success: true, users: userResults, builds: buildResults });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ success: false, message: 'Search failed due to a server error.' });
  }
});

app.put('/api/profile/:userId', authenticateToken, async (req, res) => {
  const { userId } = req.params;
  let { name, bio, avatar_url } = req.body;

  if (parseInt(req.user.id) !== parseInt(userId)) {
    return res.status(403).json({ success: false, message: 'Unauthorized.' });
  }

  try {
    let finalAvatarUrl = avatar_url;

    if (avatar_url && avatar_url.startsWith('data:image')) {
      const matches = avatar_url.match(/^data:(image\/(.+));base64,(.*)$/);
      if (matches && matches.length === 4) {
        const imageType = matches[1]; // e.g. "image/png"
        const extension = matches[2]; // e.g. "png"
        const base64Data = matches[3];

        const profileDir = path.join(__dirname, 'uploads', 'avatars', 'profilepics');
        await fs.mkdir(profileDir, { recursive: true });

        // Delete old avatar if exists
        const [userRows] = await pool.execute('SELECT avatar_url FROM users WHERE id = ?', [userId]);
        const existingAvatarUrl = userRows[0]?.avatar_url;
        if (existingAvatarUrl && existingAvatarUrl.startsWith('/uploads/avatars/profilepics/')) {
          const oldPath = path.join(__dirname, existingAvatarUrl);
          try {
            await fs.unlink(oldPath);
            console.log(`[PROFILE UPDATE] Deleted old avatar: ${oldPath}`);
          } catch (err) {
            console.warn(`[PROFILE UPDATE] Failed to delete old avatar: ${oldPath}`, err.message);
          }
        }

        // Save new avatar
        const filename = `avatar-${userId}-${Date.now()}.${extension}`;
        const filePath = path.join(profileDir, filename);
        await fs.writeFile(filePath, base64Data, 'base64');
        finalAvatarUrl = `/uploads/avatars/profilepics/${filename}`;
        console.log(`[PROFILE UPDATE] Saved uploaded avatar to: ${finalAvatarUrl}`);
      } else {
        console.warn("[PROFILE UPDATE] Invalid base64 data URI format for avatar.");
        finalAvatarUrl = null;
      }
    } else if (avatar_url === "") {
      finalAvatarUrl = null;
    }

    let setClauses = [];
    let params = [];

    if (name !== undefined) {
      setClauses.push('display_name = ?');
      params.push(name);
    }
    if (bio !== undefined) {
      setClauses.push('bio = ?');
      params.push(bio);
    }

    setClauses.push('avatar_url = ?');
    params.push(finalAvatarUrl);

    if (setClauses.length === 0) {
      return res.json({ success: true, message: 'No information provided to update.' });
    }

    params.push(userId);
    const sql = `UPDATE users SET ${setClauses.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
    await pool.execute(sql, params);

    const [updatedUsers] = await pool.execute(
      'SELECT id, username, display_name, email, bio, avatar_url FROM users WHERE id = ?',
      [userId]
    );

    res.json({ success: true, message: 'Profile updated successfully.', user: updatedUsers[0] });
  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({ success: false, message: 'Failed to update profile.' });
  }
});


app.get('/api/user-profile/:userIdToView', async (req, res) => {
  try {
    const { userIdToView } = req.params;
    const [users] = await pool.execute(
      'SELECT id, username, display_name, bio, avatar_url FROM users WHERE id = ?',
      [userIdToView]
    );

    if (users.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    res.json({ success: true, user: users[0] });
  } catch (error) {
    console.error('Error fetching user profile:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch user profile data.' });
  }
});

app.get('/test-db', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT 1 + 1 AS result');
    res.json({ success: true, result: rows[0].result });
  } catch (err) {
    console.error('DB Test Error:', err);
    res.json({ success: false, error: err.message });
  }
});

console.log('JWT_SECRET:', process.env.JWT_SECRET);

//-----------------------CAR BUILD ROUTES-----------------------//
const carBuildRoutes = require('./routes/carBuilds.js')(pool);
app.use('/api/builds', require('./routes/carBuilds')(pool));

// for follow
const followRoutes = require('./routes/follows.js')(pool);
app.use('/api/follows', followRoutes);