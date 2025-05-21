const express = require('express');
const ensureAuthenticated = require('../middleware/ensureAuthenticated');

function createFollowsRoutes(pool) {
    const router = express.Router();

    router.post('/', ensureAuthenticated, async (req, res) => {
        const followerId = req.user.id;
        const { followedId } = req.body;

        if (!followedId) {
            return res.status(400).json({ success: false, message: 'followedId is required.' });
        }
        if (followerId === parseInt(followedId)) {
            return res.status(400).json({ success: false, message: 'You cannot follow yourself.' });
        }

        try {
            await pool.execute(
                'INSERT INTO follows (follower_id, followed_id) VALUES (?, ?)',
                [followerId, followedId]
            );
            res.status(201).json({ success: true, message: 'Successfully followed user.' });
        } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') {
                return res.status(409).json({ success: false, message: 'You are already following this user.' });
            }
            console.error('Error following user:', error);
            res.status(500).json({ success: false, message: 'Server error while trying to follow user.' });
        }
    });

    router.delete('/:followedId', ensureAuthenticated, async (req, res) => {
        const followerId = req.user.id;
        const { followedId } = req.params;

        try {
            const [result] = await pool.execute(
                'DELETE FROM follows WHERE follower_id = ? AND followed_id = ?',
                [followerId, followedId]
            );
            if (result.affectedRows === 0) {
                return res.status(404).json({ success: false, message: 'You are not following this user or user not found.' });
            }
            res.json({ success: true, message: 'Successfully unfollowed user.' });
        } catch (error) {
            console.error('Error unfollowing user:', error);
            res.status(500).json({ success: false, message: 'Server error while trying to unfollow user.' });
        }
    });

    router.get('/status/:targetUserId', ensureAuthenticated, async (req, res) => {
        const loggedInUserId = req.user.id;
        const { targetUserId } = req.params;
        try {
            const [[follow]] = await pool.execute(
                'SELECT 1 FROM follows WHERE follower_id = ? AND followed_id = ?',
                [loggedInUserId, targetUserId]
            );
            res.json({ success: true, isFollowing: !!follow });
        } catch (error) {
            console.error('Error fetching follow status:', error);
            res.status(500).json({ success: false, message: 'Server error.' });
        }
    });

    router.get('/:userId/followers', async (req, res) => {
        const { userId } = req.params;
        try {
            const [followers] = await pool.execute(
                `SELECT u.id, u.username, u.display_name, u.avatar_url 
                FROM users u
                JOIN follows f ON u.id = f.follower_id
                WHERE f.followed_id = ?`,
                [userId]
            );
            res.json({ success: true, followers });
        } catch (error) {
            console.error('Error fetching followers:', error);
            res.status(500).json({ success: false, message: 'Server error.' });
        }
    });

    router.get('/:userId/following', async (req, res) => {
        const { userId } = req.params;
        try {
            const [following] = await pool.execute(
                `SELECT u.id, u.username, u.display_name, u.avatar_url 
                FROM users u
                JOIN follows f ON u.id = f.followed_id
                WHERE f.follower_id = ?`,
                [userId]
            );
            res.json({ success: true, following });
        } catch (error) {
            console.error('Error fetching following list:', error);
            res.status(500).json({ success: false, message: 'Server error.' });
        }
    });

    return router;
}

module.exports = createFollowsRoutes;