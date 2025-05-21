// -------------------------------------------------------------------------------------------//
// The following middleware was implemented with the help of ChatGPT.
// I used ChatGPT to assist with structuring the logic for verifying JWT tokens from cookies,
// since I (Adelina) was not fully familiar with cookie-based authentication (which Jesse originally handled).
// This helped me ensure the authentication flow aligns with our backend requirements.
// -------------------------------------------------------------------------------------------//
const jwt = require('jsonwebtoken');

module.exports = function ensureAuthenticated(req, res, next) {
  try {
    // Retrieve the token from the user's cookies
    const token = req.cookies.token;
    // If no token is found, deny access
    if (!token) {
      return res
        .status(401)
        .json({ success: false, message: 'Token required' });
    }

    // Verify the token using the secret key and extract the payload
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // Attach user details from the token to the request object
    req.userId = payload.id;          // Used to check build ownership
    // req.username = payload.username;  // Can be used for logging or display
    req.user = payload;            // Attach the entire user object if needed

    // Continue to the next middleware or route handler
    next();
  } catch (err) {
    // Token is invalid or expired
    console.error('Auth middleware error:', err);
    return res
      .status(401)
      .json({ success: false, message: 'Invalid or expired token' });
  }
};
