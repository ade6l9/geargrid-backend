const express = require('express');
const multer = require('multer');
const path = require('path');
const ensureAuthenticated = require('../middleware/ensureAuthenticated');
const uploadsDir = path.join(__dirname, '..', 'uploads'); 

// Configure multer to store files in the uploads directory
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${file.fieldname}${ext}`);
  }
});

const upload = multer({ storage });

// Returns a configured router for car builds
function createCarBuildRoutes(pool) {
  const router = express.Router();
  router.get('/', ensureAuthenticated, async (req, res) => {
    try {
      const loggedInUserId = req.user ? req.user.id : null;
      const targetUserId = req.query.userId || loggedInUserId;

      if (!targetUserId) {
        return res.status(400).json({ success: false, message: "User ID not found for fetching builds." });
      }

      const [currentRows] = await pool.execute(
        `SELECT id, car_name, cover_image, ownership_status, model, body_style, description
           FROM builds 
          WHERE user_id = ? 
            AND ownership_status = 'current'`,
        [targetUserId]
      );

      const [previousRows] = await pool.execute(
        `SELECT id, car_name, cover_image, ownership_status, model, body_style, description
           FROM builds 
          WHERE user_id = ? 
            AND ownership_status = 'previous'`,
        [targetUserId]
      );

      return res.json({
        success: true,
        currentBuilds: currentRows,
        previousBuilds: previousRows
      });

    } catch (err) {
      console.error('Error in GET /api/builds:', err);
      return res.status(500).json({ success: false, message: 'Server error' });
    }
  });

 /**
 * @route   GET /api/builds/:id
 * @desc    Fetch a single build (with covers, gallery & mods)
 * @access  Protected (requires valid JWT via ensureAuthenticated)
 */
router.get('/:id', ensureAuthenticated, async (req, res) => {
  const buildId = req.params.id;
  const loggedInUserId = req.user ? req.user.id : null;

  if (!loggedInUserId) {
    return res.status(401).json({ success: false, message: "Authentication required." });
  }

  try {
    // Fetch build row
    const [[row]] = await pool.execute(
      `SELECT
        b.id, b.user_id, b.ownership_status AS ownership, b.car_name, b.model,
        b.description, b.body_style AS bodyStyle, b.cover_image, b.cover_image2,
        u.username as owner_username
      FROM builds b
      JOIN users u ON b.user_id = u.id
      WHERE b.id = ?`,
      [buildId]
    );

    if (!row) {
      return res
        .status(404)
        .json({ success: false, message: 'Build not found or access denied' });
    }

    const isOwner = row.user_id === loggedInUserId;

    // Fetch gallery images
    const [galleryRows] = await pool.execute(
      `SELECT image_url
         FROM build_gallery
        WHERE build_id = ?`,
      [buildId]
    );
    const galleryImages = galleryRows.map(r => r.image_url);

    // Fetch mods with original column names
    const [modRows] = await pool.execute(
      `SELECT
         id,
         category,
         sub_category,
         mod_name,
         image_url,
         mod_note
       FROM build_mods
       WHERE build_id = ?`,
      [buildId]
    );

    // Assemble response
    const build = {
      id:           row.id,
      user_id:      row.user_id,
      ownership:    row.ownership,
      car_name:     row.car_name,
      model:        row.model,
      description:  row.description,
      bodyStyle:    row.bodyStyle,
      cover_image:  row.cover_image,
      cover_image2: row.cover_image2,
      coverImages:  [row.cover_image, row.cover_image2].filter(Boolean),
      galleryImages
    };

    return res.json({
      success: true,
      build,
      mods: modRows,
      isOwner
    });
  } catch (err) {
    console.error('Error in GET /api/builds/:id:', err);
    return res
      .status(500)
      .json({ success: false, message: 'Server error while fetching build' });
  }
});

/*
 * @route   POST /api/builds
 * @desc    Create a new car build with optional file uploads and mods
 * @access  Protected (requires valid JWT via ensureAuthenticated)
 * @form    multipart/form-data
 */
router.post(
  '/',
  ensureAuthenticated,
  upload.fields([
    { name: 'coverImages',   maxCount: 2  },
    { name: 'galleryImages', maxCount: 10 },
    { name: 'modImages',      maxCount: 50 }
  ]),
  async (req, res) => {
    try {
      // --- Log exactly what Multer parsed ---
      console.log('💾 [BUILD] all req.files keys:', Object.keys(req.files || {}));
      console.log('💾 [BUILD] req.files.coverImages:', req.files.coverImages);
      console.log('💾 [BUILD] req.files.galleryImages:', req.files.galleryImages);
      console.log('💾 [BUILD] req.files.modImages:', req.files.modImages);

      const userId = req.user.id;
      const {
        ownership   = 'current',
        car_name,
        model,
        description = null,
        bodyStyle   = null,
        mods        = '[]'
      } = req.body;

      // --- Extract cover URLs ---
      // const coverFiles = req.files.coverImages || [];
      const coverImage   = req.files.coverImages && req.files.coverImages[0] ? `/uploads/${req.files.coverImages[0].filename}` : null;
      const coverImage2  = req.files.coverImages && req.files.coverImages[1] ? `/uploads/${req.files.coverImages[1].filename}` : null;
      console.log('💾 [BUILD] coverImage, coverImage2 =', coverImage, coverImage2);

      // --- Parse mods JSON ---
      let parsedModsArray = [];
      try {
        parsedModsArray = JSON.parse(mods);
      } catch (e) {
        console.error('❌ Bad mods JSON:', e);
        return res.status(400).json({ success:false, message:'Bad mods JSON' });
      }

      // --- Insert build row with covers ---
      const [buildResult] = await pool.execute(
        `INSERT INTO builds
           (user_id, ownership_status, car_name, model,
            description, body_style, cover_image, cover_image2)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [ userId, ownership, car_name, model,
          description, bodyStyle, coverImage, coverImage2 ]
      );
      const buildId = buildResult.insertId;
      console.log('💾 [BUILD] buildId =', buildId);

      // --- Extract and insert gallery images ---
      const galleryFiles = req.files.galleryImages || [];
      const galleryUrls  = galleryFiles.map(f => `/uploads/${f.filename}`);
      console.log('💾 [BUILD] galleryUrls =', galleryUrls);

      for (const url of galleryUrls) {
        await pool.execute(
          `INSERT INTO build_gallery (build_id, image_url)
             VALUES (?, ?)`,
          [ buildId, url ]
        );
      }

      // --- Extract and insert mod images ---
      const modFiles = req.files.modImages || [];
      for (const [i, mod] of parsedModsArray.entries()) {
        const fileObj  = modFiles[i];
        const imageUrl = fileObj ? `/uploads/${fileObj.filename}` : null;
        await pool.execute(
          `INSERT INTO build_mods
             (build_id, category, sub_category, mod_name, image_url, mod_note)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            buildId,
            mod.main,
            mod.sub      || null,
            mod.name,
            imageUrl,
            mod.details  || null
          ]
        );
      }

      return res.status(201).json({ success:true, buildId });
    } catch (err) {
      console.error('[BUILD ERROR]:', err);
      return res.status(500).json({ success:false, message:'Server error' });
    }
  }
);

/**
 * @route   PUT /api/builds/:id
 * @desc    Update an existing car build (fields + covers + gallery + mods)
 * @access  Protected (owner only)
 */
router.put(
  '/:id',
  ensureAuthenticated,
  upload.fields([
    { name: 'coverImages',   maxCount: 2   },
    { name: 'galleryImages', maxCount: 10  },
    { name: 'modImages',     maxCount: 20  }
  ]),
  async (req, res) => {
    const buildId = +req.params.id;
    const userId  = req.userId;

    // Basic fields
    const ownershipStatus = req.body.ownership    ?? '';
    const car_name        = req.body.car_name     ?? '';
    const model           = req.body.model        ?? '';
    const bodyStyle       = req.body.bodyStyle    ?? null;
    const description     = req.body.description  ?? '';

    // JSON → arrays
    let keepCoversArr = [], keepGalleryArr = [], modsArr = [];
    try {
      keepCoversArr  = JSON.parse(req.body.keepCovers  || '[]');
      keepGalleryArr = JSON.parse(req.body.keepGallery || '[]');
      modsArr        = JSON.parse(req.body.mods        || '[]');
    } catch (err) {
      return res.status(400).json({ success: false, message: 'Invalid JSON payload' });
    }

    // Uploaded files
    const newCoverFiles   = req.files.coverImages   || [];
    const newGalleryFiles = req.files.galleryImages || [];
    const newModFiles     = req.files.modImages     || [];

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Ownership check
      const [ownerRows] = await conn.query(
        'SELECT user_id FROM builds WHERE id = ? FOR UPDATE',
        [buildId]
      );
      if (!ownerRows.length || ownerRows[0].user_id !== userId) {
        throw new Error('NOT_OWNER');
      }

      // Update main builds row (without cover_image columns yet)
      await conn.query(
        `UPDATE builds
           SET ownership_status = ?,
               car_name         = ?,
               model            = ?,
               body_style       = ?,
               description      = ?
         WHERE id = ?`,
        [ownershipStatus, car_name, model, bodyStyle, description, buildId]
      );

      // Updating cover_image & cover_image2 columns directly
      // Combining "kept" URLs with any new uploads, preserving order
      const allCovers = [
        ...keepCoversArr,
        ...newCoverFiles.map(f => `/uploads/${f.filename}`)
      ];
      const cover1 = allCovers[0] || null;
      const cover2 = allCovers[1] || null;
      await conn.query(
        `UPDATE builds
           SET cover_image  = ?,
               cover_image2 = ?
         WHERE id = ?`,
        [cover1, cover2, buildId]
      );

// Reconcile build_gallery
await conn.query(
  `DELETE FROM build_gallery
     WHERE build_id = ?
       AND image_url NOT IN (?)`,
  [
    buildId,
    keepGalleryArr.length
      ? keepGalleryArr
      : ['__NONE__']
  ]
);

// Insert any newly uploaded gallery images
const newGalleryFiles = req.files.galleryImages || [];
if (newGalleryFiles.length) {
  const galleryRows = newGalleryFiles.map(f => [
    buildId,
    `/uploads/${f.filename}`
  ]);
  await conn.query(
    `INSERT INTO build_gallery (build_id, image_url) VALUES ?`,
    [galleryRows]
  );
}

      // Reconcile build_mods (same as before)
      await conn.query(
        'DELETE FROM build_mods WHERE build_id = ?',
        [buildId]
      );
      let imgIdx = 0;
      for (const m of modsArr) {
        const main      = m.main    ?? '';
        const sub       = m.sub     ?? '';
        const name      = m.name    ?? '';
        const details   = m.details ?? '';
        const hasImage = m.hasImage;
        const fallback = m.image_url ?? null;
        const deleteImage = m.deleteImage ?? false;

        let image_url = null;
        if (hasImage && newModFiles[imgIdx]) {
          image_url = `/uploads/${newModFiles[imgIdx].filename}`;
          imgIdx++;
        } else if (!hasImage && fallback) {
          image_url = fallback;
        }

        await conn.query(
          `INSERT INTO build_mods
             (build_id, category, sub_category, mod_name, mod_note, image_url)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [buildId, main, sub, name, details, image_url]
        );
      }

      await conn.commit();
      conn.release();
      return res.json({ success: true });
    } catch (err) {
      await conn.rollback();
      conn.release();
      if (err.message === 'NOT_OWNER') {
        return res.status(403).json({ success: false, message: 'Unauthorized' });
      }
      console.error('Error updating build:', err);
      return res.status(500).json({ success: false, message: 'Server error' });
    }
  }
);

/**
 * @route   DELETE /api/builds/:id
 * @desc    Delete a build and its related gallery & mods
 * @access  Protected (owner only)
 */
router.delete('/:id', ensureAuthenticated, async (req, res) => {
  const buildId = req.params.id;
  const userId  = req.user.id;
  const conn    = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // Verify ownership
    const [rows] = await conn.query(
      `SELECT user_id FROM builds WHERE id = ? FOR UPDATE`,
      [buildId]
    );
    if (!rows.length || rows[0].user_id !== userId) {
      throw new Error('NOT_OWNER');
    }

    // Delete related mods
    await conn.query(
      `DELETE FROM build_mods WHERE build_id = ?`,
      [buildId]
    );

    // Delete gallery entries
    await conn.query(
      `DELETE FROM build_gallery WHERE build_id = ?`,
      [buildId]
    );

    // Delete the build row last
    await conn.query(
      `DELETE FROM builds WHERE id = ?`,
      [buildId]
    );

    await conn.commit();
    conn.release();
    return res.json({ success: true });
  } catch (err) {
    await conn.rollback();
    conn.release();
    if (err.message === 'NOT_OWNER') {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    console.error('Error deleting build:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

  // Return the router to be used in server.js
  return router;
}

// Export the function that provides the router
module.exports = createCarBuildRoutes;
