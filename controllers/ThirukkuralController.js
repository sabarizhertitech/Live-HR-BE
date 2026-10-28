const cron = require('node-cron');
const mongoose = require('mongoose');
const Thirukkural = require('../Models/Thirukkural');

const CONFIG = {
  TIMEZONE: 'Asia/Kolkata',
  CRON_SCHEDULE: '0 0,6,12,18 * * *',
};

/**
 * 🔄 ROTATE KURAL (ATOMIC + SAFE)
 */
async function rotateKural() {
  const session = await mongoose.startSession();

  try {
    let newKural = null;

    await session.withTransaction(async () => {
      console.log('🔄 Rotating Thirukkural...');

      // 1. Remove current showing
      await Thirukkural.updateMany(
        { currentShowing: true },
        { $set: { currentShowing: false } },
        { session }
      );

      // 2. Try to pick random unseen kural (FAST using $sample)
      const result = await Thirukkural.aggregate([
        { $match: { shown: false } },
        { $sample: { size: 1 } }
      ]).session(session);

      // 3. If all kurals used → reset
      if (!result.length) {
        console.log('🔄 All kurals shown. Resetting...');

        await Thirukkural.updateMany(
          {},
          { $set: { shown: false } },
          { session }
        );

        const resetPick = await Thirukkural.aggregate([
          { $sample: { size: 1 } }
        ]).session(session);

        if (!resetPick.length) {
          throw new Error('No kural found after reset');
        }

        newKural = resetPick[0];
      } else {
        newKural = result[0];
      }

      // 4. Safety check
      if (!newKural) {
        throw new Error('Failed to select a kural');
      }

      // 5. Mark selected kural
      await Thirukkural.updateOne(
        { _id: newKural._id },
        {
          $set: {
            shown: true,
            currentShowing: true,
          },
        },
        { session }
      );

      console.log(`✅ New Kural #${newKural.Number} is now active`);
    });

    return newKural;

  } catch (error) {
    console.error('❌ Rotation failed:', error);
    throw error;
  } finally {
    session.endSession();
  }
}

/**
 * ⏰ CRON JOB
 */
cron.schedule(
  CONFIG.CRON_SCHEDULE,
  async () => {
    console.log('\n⏰ CRON triggered - Rotating Thirukkural...');
    try {
      await rotateKural();
    } catch (err) {
      console.error('❌ CRON rotation failed:', err.message);
    }
  },
  {
    timezone: CONFIG.TIMEZONE,
  }
);

/**
 * 📡 CONTROLLER
 */
const ThirukkuralController = {

  /**
   * GET CURRENT KURAL
   */
  getCurrentKural: async (req, res) => {
    try {
      let kural = await Thirukkural.findOne({ currentShowing: true });

      // If none exists → create one safely
      if (!kural) {
        console.log('No active kural. Rotating...');
        kural = await rotateKural();

        // Fetch again to ensure consistency
        kural = await Thirukkural.findOne({ currentShowing: true });
      }

      if (!kural) {
        return res.status(500).json({
          success: false,
          message: 'No kural available',
        });
      }

      return res.status(200).json({
        success: true,
        data: kural,
      });

    } catch (error) {
      console.error('❌ Fetch error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch kural',
        error: error.message,
      });
    }
  },

  /**
   * MANUAL ROTATE
   */
  manualRotate: async (req, res) => {
    try {
      const newKural = await rotateKural();

      return res.status(200).json({
        success: true,
        message: 'Kural rotated successfully',
        data: newKural,
      });

    } catch (error) {
      console.error('❌ Manual rotate error:', error);

      return res.status(500).json({
        success: false,
        message: 'Failed to rotate kural',
        error: error.message,
      });
    }
  },

};

module.exports = ThirukkuralController;