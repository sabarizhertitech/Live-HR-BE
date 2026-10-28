require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const moment = require('moment');

// === CUB Bank UAT Credentials & Configuration ===
const CUB_CONFIG = {
  BASE_URL: process.env.CUB_UAT_BASE_URL || 'https://upiuat.cubuat.bank.in',
  HEAD_MERCHANT_ID: 'AR6011626713203517',
  SEC_KEY: 'wzjkY5frPu2e9vYXqgAkNiOG3e16pK0nguy8pg6IHjc=',
  DEFAULT_HANDLE: '@cubupi',
  PATH_PREFIX: '/Aquaone/cags/RequestServlet', // Aquaone for UAT
};

/**
 * Encrypt JSON payload using AES-256-GCM / NoPadding
 * Prepend 16-byte random IV + encrypted bytes + 16-byte GCM auth tag, then Base64 encode
 */
function encryptPayload(jsonObj, secKeyBase64 = CUB_CONFIG.SEC_KEY) {
  try {
    const jsonString = typeof jsonObj === 'string' ? jsonObj : JSON.stringify(jsonObj);
    const key = Buffer.from(secKeyBase64, 'base64');
    const iv = crypto.randomBytes(16); // 16 bytes IV
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    const encrypted = Buffer.concat([
      cipher.update(jsonString, 'utf8'),
      cipher.final()
    ]);
    const authTag = cipher.getAuthTag(); // 16 bytes auth tag

    // Total byte array: IV (16 bytes) + ciphertext + auth tag (16 bytes)
    const cipherTextWithIv = Buffer.concat([iv, encrypted, authTag]);
    return cipherTextWithIv.toString('base64');
  } catch (err) {
    console.error('❌ CUB Encryption error:', err.message);
    throw new Error(`Encryption failed: ${err.message}`);
  }
}

/**
 * Decrypt Base64 encoded payload using AES-256-GCM
 */
function decryptPayload(encdataBase64, secKeyBase64 = CUB_CONFIG.SEC_KEY) {
  try {
    const key = Buffer.from(secKeyBase64, 'base64');
    const buffer = Buffer.from(encdataBase64, 'base64');

    if (buffer.length < 32) {
      throw new Error('Encrypted payload too short (must contain at least 16 bytes IV + 16 bytes Tag)');
    }

    const iv = buffer.subarray(0, 16);
    const authTag = buffer.subarray(buffer.length - 16);
    const encrypted = buffer.subarray(16, buffer.length - 16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]);

    const decryptedStr = decrypted.toString('utf8');
    try {
      return JSON.parse(decryptedStr);
    } catch {
      return decryptedStr;
    }
  } catch (err) {
    console.error('❌ CUB Decryption error:', err.message);
    throw new Error(`Decryption failed: ${err.message}`);
  }
}

/**
 * Helper to make encrypted POST request to CUB Bank API
 */
async function sendCubRequest(url, payload, entMerchantId = CUB_CONFIG.HEAD_MERCHANT_ID) {
  console.log(`\n📤 [CUB REQ] URL: ${url}`);
  console.log(`📦 [CUB REQ] Payload:`, JSON.stringify(payload, null, 2));

  const encryptedData = encryptPayload(payload);
  const requestBody = {
    entMerchantId: entMerchantId,
    encdata: encryptedData,
  };

  const response = await axios.post(url, requestBody, {
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    timeout: 30000,
  });

  console.log(`📥 [CUB RAW RES STATUS]:`, response.status);
  console.log(`📥 [CUB RAW RES BODY]:`, response.data);

  let responseData = response.data;
  if (responseData && responseData.encdata) {
    responseData = decryptPayload(responseData.encdata);
    console.log(`🔓 [CUB DECRYPTED RES]:`, JSON.stringify(responseData, null, 2));
  }

  return {
    raw: response.data,
    data: responseData,
  };
}

/**
 * Generate unique Txn ID
 */
function generateTxnId(prefix = 'CUB') {
  return `${prefix}${Date.now()}${Math.floor(1000 + Math.random() * 9000)}`;
}

// =========================================================================
// 1. ONBOARDING & SUB-MERCHANT APIS
// =========================================================================

/**
 * 1. Sub Merchant Onboarding Request
 * Service: MerchantCreation
 */
exports.createSubMerchant = async (req, res) => {
  try {
    const {
      pgMerchantId = CUB_CONFIG.HEAD_MERCHANT_ID,
      txnId = generateTxnId('ONB'),
      ts = moment().format('YYYY-MM-DDTHH:mm:ss[Z]'),
      title = 'Mr.',
      mebussname,
      legalStrName,
      merVirtualAdd,
      awlmcc = '7542',
      strCntMobile,
      merchantType = 'Small',
      panNo,
      gstNumber = '',
      extMID = '',
      extTID = `cub${Date.now().toString().slice(-7)}`,
      accNo = '',
      ifscCode = '',
      accType = 'SAVINGS',
      meEmailID,
      onboardingType = 'AGGREGATOR',
      merchantGenre = 'online',
      ownerShipType = 'public',
      kycFlag = 'Y',
      verifiedFlag = 'Y',
      MerAggDetailsFlag = 'Y',
      website = 'www.ertitech.com',
      logoUrl = 'https://ertitech.com/logo.png',
      publicKey = 'sample_public_key',
      splFeatSup = 'CC,PPI,SPLC,CLP',
      fileType = 'PHOTO',
      fileData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      fileName = 'PHOTO.png',
      AggAddressFlag = 'N',
      merAddress = 'Default Merchant Address',
      merPincode = '626124',
      turnoverFlag = 'N',
      turnover = '5',
      soundBoxVen = '',
      soundBoxSerNo = '',
    } = req.body;

    if (!mebussname || !legalStrName || !strCntMobile || !panNo || !meEmailID) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: mebussname, legalStrName, strCntMobile, panNo, meEmailID are mandatory',
      });
    }

    let formattedVpa = merVirtualAdd ? merVirtualAdd.trim().toLowerCase() : '';
    if (!formattedVpa) {
      const cleanBusName = mebussname.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      formattedVpa = `${cleanBusName}${CUB_CONFIG.DEFAULT_HANDLE}`;
    } else if (!formattedVpa.includes('@')) {
      formattedVpa = `${formattedVpa}${CUB_CONFIG.DEFAULT_HANDLE}`;
    }

    const payload = {
      pgMerchantId,
      txnId,
      ts,
      title,
      mebussname,
      legalStrName,
      merVirtualAdd: formattedVpa,
      awlmcc,
      strCntMobile,
      merchantType,
      panNo,
      gstNumber,
      extMID,
      extTID,
      accNo,
      ifscCode,
      accType,
      meEmailID,
      onboardingType,
      merchantGenre,
      ownerShipType,
      kycFlag,
      verifiedFlag,
      MerAggDetailsFlag,
      website,
      logoUrl,
      publicKey,
      splFeatSup,
      fileType,
      fileData,
      fileName,
      AggAddressFlag,
      merAddress,
      merPincode,
      turnoverFlag,
      turnover,
      soundBoxVen,
      soundBoxSerNo,
    };

    const url = `${CUB_CONFIG.BASE_URL}${CUB_CONFIG.PATH_PREFIX}?serviceName=MerchantCreation&type=ALL&category=ALL&entityName=cub&channelCode=POS&engineName=cags&productName=UPI`;
    const result = await sendCubRequest(url, payload, pgMerchantId);

    return res.status(200).json({
      success: true,
      message: 'Sub merchant onboarding request initiated successfully',
      requestTxnId: txnId,
      data: result.data,
    });
  } catch (err) {
    console.error('❌ createSubMerchant error:', err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: err.message || 'Sub merchant onboarding request failed',
      error: err.response?.data || null,
    });
  }
};

/**
 * 2. Merchant Onboarding Status Enquiry / Merchant API Status Enquiry
 * Service: MerchantOnboardingEnquiry
 */
exports.getOnboardingStatus = async (req, res) => {
  try {
    const { txnId, requestId, vpa } = req.body;

    if (!txnId && !requestId && !vpa) {
      return res.status(400).json({
        success: false,
        message: 'Either txnId, requestId, or vpa is required to check status',
      });
    }

    const payload = {
      txnId: txnId || '',
      requestId: requestId || '',
      vpa: vpa ? vpa.trim().toLowerCase() : '',
    };

    const url = `${CUB_CONFIG.BASE_URL}${CUB_CONFIG.PATH_PREFIX}?serviceName=MerchantOnboardingEnquiry&type=ALL&category=ALL&entityName=cub&channelCode=POS&engineName=cags`;
    const result = await sendCubRequest(url, payload, CUB_CONFIG.HEAD_MERCHANT_ID);

    return res.status(200).json({
      success: true,
      message: 'Onboarding status fetched successfully',
      data: result.data,
    });
  } catch (err) {
    console.error('❌ getOnboardingStatus error:', err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: err.message || 'Failed to fetch onboarding status',
      error: err.response?.data || null,
    });
  }
};

/**
 * 3. Check Virtual Address Availability
 * Service: ChkVpaAvlblty
 */
exports.checkVpaAvailability = async (req, res) => {
  try {
    const {
      pgMerchantId = CUB_CONFIG.HEAD_MERCHANT_ID,
      txnId = generateTxnId('CHK'),
      ts = moment().format('YYYY-MM-DDTHH:mm:ss[Z]'),
      vpa,
    } = req.body;

    if (!vpa) {
      return res.status(400).json({
        success: false,
        message: 'VPA is required to check availability',
      });
    }

    let formattedVpa = vpa.trim().toLowerCase();
    if (!formattedVpa.includes('@')) {
      formattedVpa = `${formattedVpa}${CUB_CONFIG.DEFAULT_HANDLE}`;
    }

    const payload = {
      pgMerchantId,
      txnId,
      ts,
      vpa: formattedVpa,
    };

    const url = `${CUB_CONFIG.BASE_URL}${CUB_CONFIG.PATH_PREFIX}?serviceName=ChkVpaAvlblty&type=ALL&category=ALL&entityName=cub&channelCode=POS&engineName=cags`;
    const result = await sendCubRequest(url, payload, pgMerchantId);

    return res.status(200).json({
      success: true,
      data: result.data,
    });
  } catch (err) {
    console.error('❌ checkVpaAvailability error:', err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: err.message || 'Failed to check VPA availability',
      error: err.response?.data || null,
    });
  }
};

/**
 * 4. Validate Virtual Address (Sync)
 * Service: ValVpa
 */
exports.validateVpaSync = async (req, res) => {
  try {
    const {
      pgMerchantId = CUB_CONFIG.HEAD_MERCHANT_ID,
      txnId = generateTxnId('VAL'),
      ts = moment().format('YYYY-MM-DDTHH:mm:ss[Z]'),
      vpa,
      merchantMobile = '919876543210',
      merchantDeviceGeoCode = 'NA',
      merchantDeviceLocation = 'NA',
      merchantDeviceIP = '127.0.0.1',
      merchantDeviceType = 'INET',
      merchantDeviceId = 'WEB001',
      merchantDeviceOS = 'WEB',
      merchantDeviceAppName = 'ERTIPAY',
    } = req.body;

    if (!vpa) {
      return res.status(400).json({
        success: false,
        message: 'VPA is required for validation',
      });
    }

    const payload = {
      pgMerchantId,
      txnId,
      ts,
      vpa: vpa.trim().toLowerCase(),
      merchantMobile,
      merchantDeviceGeoCode,
      merchantDeviceLocation,
      merchantDeviceIP,
      merchantDeviceType,
      merchantDeviceId,
      merchantDeviceOS,
      merchantDeviceAppName,
    };

    const url = `${CUB_CONFIG.BASE_URL}${CUB_CONFIG.PATH_PREFIX}?serviceName=ValVpa&type=ALL&category=ALL&entityName=cub&channelCode=POS&engineName=cags`;
    const result = await sendCubRequest(url, payload, pgMerchantId);

    return res.status(200).json({
      success: true,
      data: result.data,
    });
  } catch (err) {
    console.error('❌ validateVpaSync error:', err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: err.message || 'Failed to validate VPA (Sync)',
      error: err.response?.data || null,
    });
  }
};
exports.validateVpa = exports.validateVpaSync;

/**
 * 5. Validate Virtual Address (Async)
 * Service: ValVpaAsync
 */
exports.validateVpaAsync = async (req, res) => {
  try {
    const {
      pgMerchantId = CUB_CONFIG.HEAD_MERCHANT_ID,
      txnId = generateTxnId('VALA'),
      ts = moment().format('YYYY-MM-DDTHH:mm:ss[Z]'),
      vpa,
      merchantMobile = '919876543210',
      merchantDeviceGeoCode = 'NA',
      merchantDeviceLocation = 'NA',
      merchantDeviceIP = '127.0.0.1',
      merchantDeviceType = 'MOB',
      merchantDeviceId = 'OP123456',
      merchantDeviceOS = 'ANDROID',
      merchantDeviceAppName = 'GPAY',
    } = req.body;

    if (!vpa) {
      return res.status(400).json({
        success: false,
        message: 'VPA is required for async validation',
      });
    }

    const payload = {
      pgMerchantId,
      txnId,
      ts,
      vpa: vpa.trim().toLowerCase(),
      merchantMobile,
      merchantDeviceGeoCode,
      merchantDeviceLocation,
      merchantDeviceIP,
      merchantDeviceType,
      merchantDeviceId,
      merchantDeviceOS,
      merchantDeviceAppName,
    };

    const url = `${CUB_CONFIG.BASE_URL}${CUB_CONFIG.PATH_PREFIX}?serviceName=ValVpaAsync&type=ALL&category=ALL&entityName=cub&channelCode=POS&engineName=cags`;
    const result = await sendCubRequest(url, payload, pgMerchantId);

    return res.status(200).json({
      success: true,
      message: 'Async VPA validation initiated successfully',
      data: result.data,
    });
  } catch (err) {
    console.error('❌ validateVpaAsync error:', err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: err.message || 'Failed to validate VPA (Async)',
      error: err.response?.data || null,
    });
  }
};

/**
 * 6. Sub Merchant Update Request
 * Service: MerchantUpdate
 */
exports.updateSubMerchant = async (req, res) => {
  try {
    const {
      pgMerchantId = CUB_CONFIG.HEAD_MERCHANT_ID,
      merchantID,
      txnId = generateTxnId('UPD'),
      ts = moment().format('YYYY-MM-DDTHH:mm:ss[Z]'),
      mebussname,
      legalStrName,
      strCntMobile,
      meEmailID,
      kycFlag = 'Y',
    } = req.body;

    if (!merchantID) {
      return res.status(400).json({
        success: false,
        message: 'merchantID (Sub Merchant ID) is required for update',
      });
    }

    const payload = {
      pgMerchantId,
      merchantID,
      txnId,
      ts,
      mebussname,
      legalStrName,
      strCntMobile,
      meEmailID,
      kycFlag,
    };

    const url = `${CUB_CONFIG.BASE_URL}${CUB_CONFIG.PATH_PREFIX}?serviceName=MerchantUpdate&type=ALL&category=ALL&entityName=cub&channelCode=POS&engineName=cags&productType=UPI`;
    const result = await sendCubRequest(url, payload, pgMerchantId);

    return res.status(200).json({
      success: true,
      message: 'Sub merchant updated successfully',
      data: result.data,
    });
  } catch (err) {
    console.error('❌ updateSubMerchant error:', err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: err.message || 'Failed to update sub merchant',
      error: err.response?.data || null,
    });
  }
};

/**
 * 7. Sub Merchant Deactivation / Block / Unblock
 * Service: MerchantDeactivate
 */
exports.deactivateSubMerchant = async (req, res) => {
  try {
    const {
      pgMerchantId = CUB_CONFIG.HEAD_MERCHANT_ID,
      merchantID,
      txnId = generateTxnId('DEA'),
      ts = moment().format('YYYY-MM-DDTHH:mm:ss[Z]'),
      activeFlag = 'Blk', // 'Blk' to block, 'unblk' to unblock
    } = req.body;

    if (!merchantID) {
      return res.status(400).json({
        success: false,
        message: 'merchantID (Sub Merchant ID) is required',
      });
    }

    const payload = {
      pgMerchantId,
      merchantID,
      txnId,
      ts,
      activeFlag,
    };

    const url = `${CUB_CONFIG.BASE_URL}${CUB_CONFIG.PATH_PREFIX}?serviceName=MerchantDeactivate&type=ALL&category=ALL&entityName=cub&channelCode=POS&engineName=cags&productType=UPI`;
    const result = await sendCubRequest(url, payload, pgMerchantId);

    return res.status(200).json({
      success: true,
      message: `Sub merchant ${activeFlag === 'Blk' ? 'blocked' : 'unblocked'} successfully`,
      data: result.data,
    });
  } catch (err) {
    console.error('❌ deactivateSubMerchant error:', err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: err.message || 'Failed to update merchant active status',
      error: err.response?.data || null,
    });
  }
};

// =========================================================================
// 2. PAYMENT & COLLECTION APIS
// =========================================================================

/**
 * 8. Collection Request (Payer Pull / UPI Collect)
 * Service: Collect
 */
exports.collectionRequest = async (req, res) => {
  try {
    const {
      pgMerchantId = CUB_CONFIG.HEAD_MERCHANT_ID,
      txnId = generateTxnId('COL'),
      ts = moment().format('YYYY-MM-DDTHH:mm:ss[Z]'),
      txnNote = 'Collect Request',
      initMode = '00',
      purposeCode = '00',
      refId = generateTxnId('REF'),
      refUrl = 'https://ertipay.com',
      refCategory = 'NA',
      expiryTime = '30',
      amount,
      minCollectAmount = '',
      payerVpa,
      payerName = 'Customer',
      payerType = 'PERSON',
      payerMCC = '0000',
      merchantMobile = '919876543210',
      merchantDeviceAppName = 'GPAY',
      merchantDeviceOS = 'ANDROID',
      merchantDeviceId = 'OP123456',
      merchantDeviceType = 'MOB',
      merchantDeviceIP = '127.0.0.1',
      merchantDeviceLocation = 'NA',
      merchantDeviceGeoCode = 'NA',
      addInfo9 = '',
      addInfo10 = '',
      payeeCode = '',
      payeeName = '',
    } = req.body;

    if (!amount || !payerVpa) {
      return res.status(400).json({
        success: false,
        message: 'amount and payerVpa are required for collection request',
      });
    }

    const payload = {
      pgMerchantId,
      txnId,
      ts,
      txnNote,
      initMode,
      purposeCode,
      refId,
      refUrl,
      refCategory,
      expiryTime: String(expiryTime),
      amount: String(amount),
      ...(minCollectAmount ? { minCollectAmount: String(minCollectAmount) } : {}),
      payerVpa: payerVpa.trim().toLowerCase(),
      payerName,
      payerType,
      payerMCC,
      merchantMobile,
      merchantDeviceAppName,
      merchantDeviceOS,
      merchantDeviceId,
      merchantDeviceType,
      merchantDeviceIP,
      merchantDeviceLocation,
      merchantDeviceGeoCode,
      addInfo9,
      addInfo10,
      ...(payeeCode ? { payeeCode } : {}),
      ...(payeeName ? { payeeName } : {}),
    };

    const url = `${CUB_CONFIG.BASE_URL}${CUB_CONFIG.PATH_PREFIX}?serviceName=Collect&type=ALL&category=ALL&entityName=cub&channelCode=POS&engineName=cags`;
    const result = await sendCubRequest(url, payload, pgMerchantId);

    return res.status(200).json({
      success: true,
      message: 'Collection request initiated successfully',
      data: result.data,
    });
  } catch (err) {
    console.error('❌ collectionRequest error:', err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: err.message || 'Failed to initiate collection request',
      error: err.response?.data || null,
    });
  }
};

/**
 * 9. ReqPay Tap & Pay Collect Service
 * Service: CollectTapPay
 */
exports.collectTapAndPay = async (req, res) => {
  try {
    const {
      pgMerchantId = CUB_CONFIG.HEAD_MERCHANT_ID,
      txnId = generateTxnId('TAP'),
      ts = moment().format('YYYY-MM-DDTHH:mm:ss[Z]'),
      txnNote = 'Tap & Pay request',
      initMode = '06',
      purposeCode = '00',
      refId = generateTxnId('REF'),
      refUrl = 'https://ertipay.com',
      refCategory = 'NA',
      expiryTime = '30',
      amount,
      minCollectAmount = '',
      payerVpa,
      payerName = 'Customer',
      payerType = 'PERSON',
      payerMCC = '0000',
      payerRef = 'SERHRjAwMDAwMDF8WFhYWFhYNjIxOHw=',
      payerdeviceMobile = '917498894549',
      payerdeviceType = 'MOB',
      payerdeviceGeoCode = '0.00,0.00',
      payerdeviceId = '5c14a0c3b37220a8',
      payerdeviceOs = 'ANDROID 13',
      payerdeviceApp = 'in.org.npci.upi',
      merchantMobile = '919876543210',
      payeeVpa,
      payeedeviceMobile = '917498894549',
      payeedeviceType = 'MOB',
      payeedeviceGeoCode = '0.00,0.00',
      payeedeviceId = '5c14a0c3b37220a8',
      payeedeviceOs = 'ANDROID 13',
      payeedeviceApp = 'in.org.npci.upi',
      deviceCredType = 'DEVICE',
      deviceCredSubType = 'Signature',
      deviceCredDataCode = 'NPCI-LITE',
      deviceCredDataki = '202112281',
      deviceCreddataContent = 'base-64 encoded/encrypted authentication data',
      ...restBody
    } = req.body;

    if (!amount || !payerVpa || !payeeVpa) {
      return res.status(400).json({
        success: false,
        message: 'amount, payerVpa, and payeeVpa are mandatory for Tap & Pay Collect',
      });
    }

    const payload = {
      pgMerchantId,
      txnId,
      ts,
      txnNote,
      initMode,
      purposeCode,
      refId,
      refUrl,
      refCategory,
      expiryTime: String(expiryTime),
      amount: String(amount),
      ...(minCollectAmount ? { minCollectAmount: String(minCollectAmount) } : {}),
      payerVpa: payerVpa.trim().toLowerCase(),
      payerName,
      payerType,
      payerMCC,
      payerRef,
      payerdeviceMobile,
      payerdeviceType,
      payerdeviceGeoCode,
      payerdeviceId,
      payerdeviceOs,
      payerdeviceApp,
      payerdeviceTelecom: '',
      payerdeviceCardAccpTrId: '',
      payerdeviceCardAccIdCode: '',
      payerdevicePosEntryCode: '',
      payerdevicePosServCdnCode: '',
      merchantMobile,
      addInfo9: '',
      addInfo10: '',
      payeeVpa: payeeVpa.trim().toLowerCase(),
      payeedeviceMobile,
      payeedeviceType,
      payeedeviceGeoCode,
      payeedeviceId,
      payeedeviceOs,
      payeedeviceApp,
      payeedeviceTelecom: '',
      payeedeviceCardAccpTrId: '',
      payeedeviceCardAccIdCode: '',
      payeedevicePosEntryCode: '',
      payeedevicePosServCdnCode: '',
      deviceCredType,
      deviceCredSubType,
      deviceCredDataCode,
      deviceCredDataki,
      deviceCreddataContent,
      ...restBody,
    };

    const url = `${CUB_CONFIG.BASE_URL}${CUB_CONFIG.PATH_PREFIX}?serviceName=CollectTapPay&type=ALL&category=ALL&entityName=cub&channelCode=POS&engineName=cags`;
    const result = await sendCubRequest(url, payload, pgMerchantId);

    return res.status(200).json({
      success: true,
      message: 'Tap & Pay Collect service executed successfully',
      data: result.data,
    });
  } catch (err) {
    console.error('❌ collectTapAndPay error:', err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: err.message || 'Tap & Pay Collect failed',
      error: err.response?.data || null,
    });
  }
};

/**
 * 10. Preapproved Payment Request (Outward Pay / PreAuthPay / Payout)
 * Service: PreAuthPay
 */
exports.preapprovedPayment = async (req, res) => {
  try {
    const {
      pgMerchantId = CUB_CONFIG.HEAD_MERCHANT_ID,
      txnId = generateTxnId('PAP'),
      ts = moment().format('YYYY-MM-DDTHH:mm:ss[Z]'),
      txnNote = 'Preapproved Payment',
      initMode = '00', // 00 or 12 (FIR)
      purposeCode = '00',
      refId = generateTxnId('REF'),
      refUrl = 'https://ertipay.com',
      refCategory = 'NA',
      amount,
      payeeVpa,
      payeeName = 'Beneficiary',
      payeeType = 'PERSON',
      payeeMCC = '0000',
      payerMobile = '919876543210',
      payerDeviceOS = 'ANDROID',
      payerDeviceId = 'OP123456',
      payerDeviceType = 'MOB',
      payerDeviceIP = '127.0.0.1',
      payerDeviceLocation = 'NA',
      payerDeviceGeoCode = 'NA',
      payerDeviceAppName = 'com.cub.wallet.gui',
      currencyCode = 'INR',
      ...rest
    } = req.body;

    if (!amount || !payeeVpa) {
      return res.status(400).json({
        success: false,
        message: 'amount and payeeVpa are mandatory for preapproved payment',
      });
    }

    const payload = {
      pgMerchantId,
      txnId,
      ts,
      txnNote,
      initMode,
      purposeCode,
      refId,
      refUrl,
      refCategory,
      amount: String(amount),
      payeeVpa: payeeVpa.trim().toLowerCase(),
      payeeName,
      payeeType,
      payeeMCC,
      payerMobile,
      payerDeviceOS,
      payerDeviceId,
      payerDeviceType,
      payerDeviceIP,
      payerDeviceLocation,
      payerDeviceGeoCode,
      payerDeviceAppName,
      currencyCode,
      addInfo2: 'NA',
      addInfo3: 'NA',
      addInfo4: 'NA',
      addInfo5: 'NA',
      addInfo6: 'NA',
      addInfo7: 'NA',
      addInfo8: 'NA',
      addInfo9: 'NA',
      addInfo10: 'NA',
      ...rest,
    };

    const url = `${CUB_CONFIG.BASE_URL}${CUB_CONFIG.PATH_PREFIX}?serviceName=PreAuthPay&type=ALL&category=ALL&entityName=cub&channelCode=POS&engineName=cags`;
    const result = await sendCubRequest(url, payload, pgMerchantId);

    return res.status(200).json({
      success: true,
      message: 'Preapproved payment initiated successfully',
      data: result.data,
    });
  } catch (err) {
    console.error('❌ preapprovedPayment error:', err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: err.message || 'Preapproved payment failed',
      error: err.response?.data || null,
    });
  }
};

/**
 * 11. Transaction Enquiry (Status / List)
 * Service: TxnEnq
 */
exports.transactionEnquiry = async (req, res) => {
  try {
    const {
      searchType = 'RRN', // RRN or other
      pgMerchantId = CUB_CONFIG.HEAD_MERCHANT_ID,
      gwRrn = '',
      fromDate = '',
      toDate = '',
      phone = '',
      recordsPerPage = '',
      pageNumber = '',
      custRefNo = '',
      npciTranId = '',
      pspRefNo = '',
    } = req.body;

    const payload = {
      searchType,
      pgMerchantId,
      gwRrn: gwRrn || custRefNo || generateTxnId('ENQ'),
      fromDate,
      toDate,
      phone,
      recordsPerPage: recordsPerPage ? String(recordsPerPage) : '',
      pageNumber: pageNumber ? String(pageNumber) : '',
      custRefNo,
      npciTranId,
      pspRefNo,
    };

    const url = `${CUB_CONFIG.BASE_URL}${CUB_CONFIG.PATH_PREFIX}?serviceName=TxnEnq&type=ALL&category=ALL&entityName=cub&channelCode=POS&engineName=cags`;
    const result = await sendCubRequest(url, payload, pgMerchantId);

    return res.status(200).json({
      success: true,
      message: 'Transaction enquiry executed successfully',
      data: result.data,
    });
  } catch (err) {
    console.error('❌ transactionEnquiry error:', err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: err.message || 'Transaction enquiry failed',
      error: err.response?.data || null,
    });
  }
};

/**
 * 12. Dynamic QR / Intent Signing
 * Service: DynamicQrSignning
 */
exports.dynamicQrSigning = async (req, res) => {
  try {
    const {
      pgMerchantId = CUB_CONFIG.HEAD_MERCHANT_ID,
      merchantID = CUB_CONFIG.HEAD_MERCHANT_ID,
      txnId = generateTxnId('QRS'),
      ts = moment().format('YYYY-MM-DDTHH:mm:ss'),
      qrString,
    } = req.body;

    if (!qrString) {
      return res.status(400).json({
        success: false,
        message: 'qrString is required for QR / Intent signing',
      });
    }

    const payload = {
      pgMerchantId,
      merchantID,
      txnId,
      ts,
      qrString,
    };

    const url = `${CUB_CONFIG.BASE_URL}${CUB_CONFIG.PATH_PREFIX}?serviceName=DynamicQrSignning&type=ALL&category=ALL&entityName=cub&channelCode=POS&engineName=cags`;
    const result = await sendCubRequest(url, payload, pgMerchantId);

    return res.status(200).json({
      success: true,
      message: 'QR / Intent signed successfully',
      data: result.data,
    });
  } catch (err) {
    console.error('❌ dynamicQrSigning error:', err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: err.message || 'Dynamic QR signing failed',
      error: err.response?.data || null,
    });
  }
};

/**
 * 13. PAN Validation Request
 * Service: PANValidationRequest
 */
exports.panValidation = async (req, res) => {
  try {
    const {
      pgMerchantId = CUB_CONFIG.HEAD_MERCHANT_ID,
      txnId = generateTxnId('PAN'),
      ts = moment().format('YYYY-MM-DDTHH:mm:ss[Z]'),
      txnNote = 'PAN Validation',
      refId = generateTxnId('REF'),
      refUrl = 'https://ertipay.com',
      refCategory = 'NA',
      payerVPA = '',
      payerName = 'Payer Name',
      payerType = 'PERSON',
      payerMCC = '0000',
      payerIdType = 'PAN',
      payerIdValue,
      merchantMobile = '919876543210',
      merchantDeviceAppName = 'GPAY',
      merchantDeviceOS = 'ANDROID',
      merchantDeviceId = 'OP123456',
      merchantDeviceType = 'MOB',
      merchantDeviceIP = '127.0.0.1',
      merchantDeviceLocation = 'NA',
      merchantDeviceGeoCode = 'NA',
    } = req.body;

    if (!payerIdValue) {
      return res.status(400).json({
        success: false,
        message: 'payerIdValue (PAN number) is mandatory for PAN validation',
      });
    }

    const payload = {
      pgMerchantId,
      txnId,
      ts,
      txnNote,
      refId,
      refUrl,
      refCategory,
      payerVPA,
      payerName,
      payerType,
      payerMCC,
      payerIdType,
      payerIdValue,
      merchantMobile,
      merchantDeviceAppName,
      merchantDeviceOS,
      merchantDeviceId,
      merchantDeviceType,
      merchantDeviceIP,
      merchantDeviceLocation,
      merchantDeviceGeoCode,
    };

    const url = `${CUB_CONFIG.BASE_URL}${CUB_CONFIG.PATH_PREFIX}?serviceName=PANValidationRequest&type=ALL&category=ALL&entityName=cub&channelCode=POS&engineName=cags`;
    const result = await sendCubRequest(url, payload, pgMerchantId);

    return res.status(200).json({
      success: true,
      message: 'PAN validation request initiated successfully',
      data: result.data,
    });
  } catch (err) {
    console.error('❌ panValidation error:', err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: err.message || 'PAN validation request failed',
      error: err.response?.data || null,
    });
  }
};

// =========================================================================
// 3. MANDATE APIS (UPI 2.0 RECURRING & ONE-TIME BLOCK)
// =========================================================================

/**
 * 14. Mandate Create Request
 * Service: MandateCreate
 */
exports.createMandate = async (req, res) => {
  try {
    const {
      pgMerchantId = "CUBM626811022579",
      txnId = "CUB167A5601236e4321009t7j1b36n56041",
      ts = moment().format('YYYY-MM-DDTHH:mm:ss[Z]'),
      txnNote = 'Mandate Creation',
      initMode = '11',
      purposeCode = '14', // 01 for one-time block, 14 for recurring
      refId = generateTxnId('REF'),
      refUrl = 'https://ertipay.com',
      refCategory = 'NA',
      initiatedBy = 'PAYEE',
      expireAfter = '64800',
      mandateName = 'Ertipay Mandate',
      revokeableFlag = 'Y',
      mandateType = 'recurring',
      blockFundFlag = 'N', // N for recurring, Y for one-time
      mandateStartDate,
      mandateEndDate = moment().add(1, 'year').format('DDMMYYYY'),
      recurrenceFrequency = 'ASPRESENTED', // ONETIME, DAILY, WEEKLY, MONTHLY, ASPRESENTED, etc.
      recurrenceRuleType = '',
      recurrenceRuleValue = '',
      amount,
      amountRule = 'MAX', // MAX or EXACT
      merchantMobile = '919876543210',
      payerVpa,
      payerName = 'Customer',
      payerType = 'PERSON',
      payerMCC = '0000',
      merchantDeviceAppName = 'GPAY',
      merchantDeviceOS = 'ANDROID',
      merchantDeviceId = 'OP123456',
      merchantDeviceType = 'MOB',
      merchantDeviceIP = '127.0.0.1',
      merchantDeviceLocation = 'NA',
      merchantDeviceGeoCode = 'NA',
      payerAccountNo = '',
      accountValidation = 'N',
    } = req.body;

    if (!amount || !payerVpa) {
      return res.status(400).json({
        success: false,
        message: 'amount and payerVpa are mandatory for mandate creation',
      });
    }

    const payload = {
      pgMerchantId,
      txnId,
      txnNote,
      ts,
      initMode,
      purposeCode,
      refId,
      refUrl,
      refCategory,
      initiatedBy,
      expireAfter,
      mandateName,
      revokeableFlag,
      mandateType,
      blockFundFlag,
      mandateStartDate,
      mandateEndDate,
      recurrenceFrequency,
      recurrenceRuleType,
      recurrenceRuleValue,
      amount: String(amount),
      amountRule,
      merchantMobile,
      payerVpa: payerVpa.trim().toLowerCase(),
      payerName,
      payerType,
      payerMCC,
      merchantDeviceAppName,
      merchantDeviceOS,
      merchantDeviceId,
      merchantDeviceType,
      merchantDeviceIP,
      merchantDeviceLocation,
      merchantDeviceGeoCode,
      ...(accountValidation === 'Y' && payerAccountNo ? {
        'payerType.accountNo': payerAccountNo,
        account_validation: 'Y',
      } : {
        account_validation: accountValidation,
      }),
    };

    const url = `${CUB_CONFIG.BASE_URL}${CUB_CONFIG.PATH_PREFIX}?serviceName=MandateCreate&type=ALL&category=ALL&entityName=cub&channelCode=POS&engineName=cags`;
    const result = await sendCubRequest(url, payload, id = "AR6011626713203517");

    return res.status(200).json({
      success: true,
      message: 'Mandate creation request initiated successfully',
      requestTxnId: txnId,
      data: result.data,
    });
  } catch (err) {
    console.error('❌ createMandate error:', err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: err.message || 'Mandate creation failed',
      error: err.response?.data || null,
    });
  }
};

/**
 * 15. Mandate Update Request
 * Service: MandateUpdate
 */
exports.updateMandate = async (req, res) => {
  try {
    const {
      pgMerchantId = "CUBM626811022579",
      txnId = "CUB167A56012g6e432100nt7j1v36n56741",
      ts = moment().format('YYYY-MM-DDTHH:mm:ss[Z]'),
      txnNote = 'Mandate Update',
      initMode = '11',
      purposeCode = '14',
      refId = generateTxnId('REF'),
      refUrl = 'https://ertipay.com',
      refCategory = 'NA',
      initiatedBy = 'PAYEE',
      onBehalf_Of = 'PAYEE',
      expireAfter = '64800',
      mandateName = 'Ertipay Mandate',
      revokeableFlag = 'Y',
      mandateType = 'recurring',
      blockFundFlag = 'N',
      recurrenceFrequency = 'ASPRESENTED',
      recurrenceRuleType = '',
      recurrenceRuleValue = 'ASPRESENTED',
      mandateAction = 'UPDATE',
      mandateUMN,
      amount,
      amountRule = 'MAX',
      mandateStartDate = moment().format('DDMMYYYY'),
      mandateEndDate,
      payerVpa,
      payerName = 'Customer',
      payerType = 'PERSON',
      payerMCC = '0000',
      merchantMobile = '919876543210',
      merchantDeviceAppName = 'GPAY',
      merchantDeviceOS = 'ANDROID',
      merchantDeviceId = 'OP123456',
      merchantDeviceType = 'MOB',
      merchantDeviceIP = '127.0.0.1',
      merchantDeviceLocation = 'NA',
      merchantDeviceGeoCode = 'NA',
    } = req.body;

    if (!mandateUMN) {
      return res.status(400).json({
        success: false,
        message: 'mandateUMN is required for mandate update',
      });
    }

    const payload = {
      pgMerchantId,
      txnId,
      txnNote,
      ts,
      initMode,
      purposeCode,
      refId,
      refUrl,
      refCategory,
      initiatedBy,
      onBehalf_Of,
      expireAfter,
      mandateName,
      revokeableFlag,
      mandateType,
      blockFundFlag,
      mandateAction,
      mandateUMN,
      mandateStartDate,
      ...(mandateEndDate ? { mandateEndDate } : {}),
      recurrenceFrequency,
      recurrenceRuleType,
      recurrenceRuleValue,
      amount: amount ? String(amount) : undefined,
      amountRule,
      merchantMobile,
      ...(payerVpa ? { payerVpa: payerVpa.trim().toLowerCase() } : {}),
      payerName,
      payerType,
      payerMCC,
      merchantDeviceAppName,
      merchantDeviceOS,
      merchantDeviceId,
      merchantDeviceType,
      merchantDeviceIP,
      merchantDeviceLocation,
      merchantDeviceGeoCode,
    };

    const url = `${CUB_CONFIG.BASE_URL}${CUB_CONFIG.PATH_PREFIX}?serviceName=MandateUpdate&type=ALL&category=ALL&entityName=cub&channelCode=POS&engineName=cags`;
    const result = await sendCubRequest(url, payload, CUB_CONFIG.HEAD_MERCHANT_ID);

    return res.status(200).json({
      success: true,
      message: 'Mandate update request initiated successfully',
      data: result.data || null,
      raw: result.raw || null,
    });
  } catch (err) {

    console.error('❌ updateMandate error:', err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: err.message || 'Mandate update failed',
      error: err.response?.data || null,
    });
  }
};

/**
 * 16. Mandate Revoke Request
 * Service: MandateRevoke
 */
exports.revokeMandate = async (req, res) => {
  try {
    const {
      pgMerchantId = CUB_CONFIG.HEAD_MERCHANT_ID,
      txnId = generateTxnId('MRV'),
      ts = moment().format('YYYY-MM-DDTHH:mm:ss[Z]'),
      txnNote = 'Mandate Revoke',
      initMode = '00',
      purposeCode = '00',
      refId = generateTxnId('REF'),
      refUrl = 'https://ertipay.com',
      refCategory = '00',
      expireAfter = '64800',
      mandateAction = 'REVOKE',
      mandateUMN,
      merchantMobile = '919876543210',
      merchantDeviceAppName = 'GPAY',
      merchantDeviceOS = 'ANDROID',
      merchantDeviceId = 'OP123456',
      merchantDeviceType = 'MOB',
      merchantDeviceIP = '127.0.0.1',
      merchantDeviceLocation = 'NA',
      merchantDeviceGeoCode = 'NA',
    } = req.body;

    if (!mandateUMN) {
      return res.status(400).json({
        success: false,
        message: 'mandateUMN is required for mandate revocation',
      });
    }

    const payload = {
      pgMerchantId,
      txnId,
      txnNote,
      ts,
      initMode,
      purposeCode,
      refId,
      refUrl,
      refCategory,
      expireAfter,
      mandateAction,
      mandateUMN,
      merchantMobile,
      merchantDeviceAppName,
      merchantDeviceOS,
      merchantDeviceId,
      merchantDeviceType,
      merchantDeviceIP,
      merchantDeviceLocation,
      merchantDeviceGeoCode,
    };

    const url = `${CUB_CONFIG.BASE_URL}${CUB_CONFIG.PATH_PREFIX}?serviceName=MandateRevoke&type=ALL&category=ALL&entityName=cub&channelCode=POS&engineName=cags`;
    const result = await sendCubRequest(url, payload, pgMerchantId);

    return res.status(200).json({
      success: true,
      message: 'Mandate revoke request initiated successfully',
      data: result.data,
    });
  } catch (err) {
    console.error('❌ revokeMandate error:', err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: err.message || 'Mandate revocation failed',
      error: err.response?.data || null,
    });
  }
};

/**
 * 17. Mandate Status Enquiry
 * Service: MandateStsEnq
 */
exports.getMandateStatus = async (req, res) => {
  try {
    const {
      pgMerchantId = CUB_CONFIG.HEAD_MERCHANT_ID,
      txnId = generateTxnId('MST'),
      ts = moment().format('YYYY-MM-DDTHH:mm:ss[Z]'),
      orgTxnId,
      mandateAction = 'CREATE', // CREATE / UPDATE / REVOKE
      onBehalf_Of = 'PAYEE',
    } = req.body;

    if (!orgTxnId) {
      return res.status(400).json({
        success: false,
        message: 'orgTxnId (Original Mandate Transaction ID) is required',
      });
    }

    const payload = {
      pgMerchantId,
      txnId,
      ts,
      orgTxnId,
      mandateAction,
      onBehalf_Of,
    };

    const url = `${CUB_CONFIG.BASE_URL}${CUB_CONFIG.PATH_PREFIX}?serviceName=MandateStsEnq&type=ALL&category=ALL&entityName=cub&channelCode=POS&engineName=cags`;
    const result = await sendCubRequest(url, payload, pgMerchantId);

    return res.status(200).json({
      success: true,
      message: 'Mandate status fetched successfully',
      data: result.data,
    });
  } catch (err) {
    console.error('❌ getMandateStatus error:', err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: err.message || 'Failed to fetch mandate status',
      error: err.response?.data || null,
    });
  }
};

/**
 * 18. Mandate List Enquiry
 * Service: MandateListEnq
 */
exports.listMandates = async (req, res) => {
  try {
    const {
      pgMerchantId = CUB_CONFIG.HEAD_MERCHANT_ID,
      txnId = generateTxnId('MLS'),
      ts = moment().format('YYYY-MM-DDTHH:mm:ss[Z]'),
      fromDate = moment().subtract(7, 'days').format('DDMMYYYY'),
      toDate = moment().format('DDMMYYYY'),
      mandateStatus = 'ACTIVE', // ACTIVE, REVOKED, COMPLETED, PAUSED, EXPIRED
      fromIndex = '0',
      toIndex = '50',
      totalRecords = '50',
    } = req.body;

    const payload = {
      pgMerchantId,
      txnId,
      ts,
      fromDate,
      toDate,
      mandateStatus,
      fromIndex: String(fromIndex),
      toIndex: String(toIndex),
      totalRecords: String(totalRecords),
    };

    const url = `${CUB_CONFIG.BASE_URL}${CUB_CONFIG.PATH_PREFIX}?serviceName=MandateListEnq&type=ALL&category=ALL&entityName=cub&channelCode=POS&engineName=cags`;
    const result = await sendCubRequest(url, payload, pgMerchantId);

    return res.status(200).json({
      success: true,
      message: 'Mandates fetched successfully',
      data: result.data,
    });
  } catch (err) {
    console.error('❌ listMandates error:', err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: err.message || 'Failed to fetch mandate list',
      error: err.response?.data || null,
    });
  }
};

/**
 * 19. Mandate Pre-debit Notification
 * Service: MandatePreDebitNotification
 */
exports.sendMandatePreDebitNotification = async (req, res) => {
  try {
    const {
      pgMerchantId = CUB_CONFIG.HEAD_MERCHANT_ID,
      txnId = generateTxnId('MPD'),
      ts = moment().format('YYYY-MM-DDTHH:mm:ss[Z]'),
      txnNote = 'Pre-debit notification',
      initMode = '11',
      purposeCode = '14',
      refId = generateTxnId('REF'),
      refUrl = 'https://ertipay.com',
      refCategory = 'NA',
      initiatedBy = 'PAYEE',
      mandateUMN,
      mandateNextExecutionTs = moment().add(24, 'hours').format('YYYY-MM-DDTHH:mm:ss+05:30'),
      amount,
      payerVpa,
      payerName = 'Customer',
      payerType = 'PERSON',
      payerMCC = '0000',
      executionSeqNum = '1',
      merchantMobile = '919876543210',
      merchantDeviceAppName = 'GPAY',
      merchantDeviceOS = 'ANDROID',
      merchantDeviceId = 'OP123456',
      merchantDeviceType = 'MOB',
      merchantDeviceIP = '127.0.0.1',
      merchantDeviceLocation = 'NA',
      merchantDeviceGeoCode = 'NA',
    } = req.body;

    if (!mandateUMN || !amount || !payerVpa) {
      return res.status(400).json({
        success: false,
        message: 'mandateUMN, amount, and payerVpa are mandatory for pre-debit notification',
      });
    }

    const payload = {
      pgMerchantId,
      txnId,
      txnNote,
      ts,
      initMode,
      purposeCode,
      refId,
      refUrl,
      refCategory,
      initiatedBy,
      mandateUMN,
      mandateNextExecutionTs,
      amount: String(amount),
      payerVpa: payerVpa.trim().toLowerCase(),
      payerName,
      payerType,
      payerMCC,
      executionSeqNum: String(executionSeqNum),
      merchantMobile,
      merchantDeviceAppName,
      merchantDeviceOS,
      merchantDeviceId,
      merchantDeviceType,
      merchantDeviceIP,
      merchantDeviceLocation,
      merchantDeviceGeoCode,
    };

    const url = `${CUB_CONFIG.BASE_URL}${CUB_CONFIG.PATH_PREFIX}?serviceName=MandatePreDebitNotification&type=ALL&category=ALL&entityName=cub&channelCode=POS&engineName=cags`;
    const result = await sendCubRequest(url, payload, pgMerchantId);

    return res.status(200).json({
      success: true,
      message: 'Pre-debit notification initiated successfully',
      data: result.data,
    });
  } catch (err) {
    console.error('❌ sendMandatePreDebitNotification error:', err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: err.message || 'Failed to send pre-debit notification',
      error: err.response?.data || null,
    });
  }
};

/**
 * 20. Mandate Collection Request (Debit)
 * Service: MandateCollect
 */
exports.collectMandate = async (req, res) => {
  try {
    const {
      pgMerchantId = CUB_CONFIG.HEAD_MERCHANT_ID,
      txnId = generateTxnId('MCL'),
      ts = moment().format('YYYY-MM-DDTHH:mm:ss[Z]'),
      txnNote = 'Mandate debit execution',
      initMode = '11',
      purposeCode = '14',
      refId = generateTxnId('REF'),
      refUrl = 'https://ertipay.com',
      refCategory = 'NA',
      expiryTime = '3000',
      amount,
      mandateUMN, // Populated into payerVpa as per NPCI/CUB specs
      payerName = 'Customer',
      payerType = 'PERSON',
      payerMCC = '0000',
      executionSeqNum = '1',
      merchantMobile = '919876543210',
      merchantDeviceAppName = 'GPAY',
      merchantDeviceOS = 'ANDROID',
      merchantDeviceId = 'OP123456',
      merchantDeviceType = 'MOB',
      merchantDeviceIP = '127.0.0.1',
      merchantDeviceLocation = 'NA',
      merchantDeviceGeoCode = 'NA',
    } = req.body;

    if (!mandateUMN || !amount) {
      return res.status(400).json({
        success: false,
        message: 'mandateUMN and amount are mandatory for mandate collection',
      });
    }

    const payload = {
      pgMerchantId,
      txnId,
      txnNote,
      ts,
      initMode,
      purposeCode,
      refId,
      refUrl,
      refCategory,
      expiryTime: String(expiryTime),
      amount: String(amount),
      payerVpa: mandateUMN, // In CUB Mandate Collect, payerVpa holds the Mandate UMN
      payerName,
      payerType,
      payerMCC,
      executionSeqNum: String(executionSeqNum),
      merchantMobile,
      merchantDeviceAppName,
      merchantDeviceOS,
      merchantDeviceId,
      merchantDeviceType,
      merchantDeviceIP,
      merchantDeviceLocation,
      merchantDeviceGeoCode,
    };

    const url = `${CUB_CONFIG.BASE_URL}${CUB_CONFIG.PATH_PREFIX}?serviceName=MandateCollect&type=ALL&category=ALL&entityName=cub&channelCode=POS&engineName=cags`;
    const result = await sendCubRequest(url, payload, pgMerchantId);

    return res.status(200).json({
      success: true,
      message: 'Mandate collection initiated successfully',
      data: result.data,
    });
  } catch (err) {
    console.error('❌ collectMandate error:', err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: err.message || 'Mandate collection failed',
      error: err.response?.data || null,
    });
  }
};

// =========================================================================
// 4. DISPUTE & COMPLAINT REFUND APIS
// =========================================================================

/**
 * 21. Complaint Refund Request
 * Service: ReqComplaintRefund
 */
exports.complaintRefund = async (req, res) => {
  try {
    const {
      pgMerchantId = CUB_CONFIG.HEAD_MERCHANT_ID,
      txnId = generateTxnId('CRF'),
      ts = moment().format('YYYY-MM-DDTHH:mm:ss[Z]'),
      txnNote = 'COMPEDEP',
      initMode = 'U1', // U1/U2/U3
      purposeCode = '00',
      refId = generateTxnId('REF'),
      refUrl = 'https://ertipay.com',
      complaintTxnId = '',
      orgTxnId,
      orgRrn,
      orgTxnDate = moment().format('YYYY-MM-DDTHH:mm:ss+05:30'),
      adjAmount,
      adjCode = '1064',
    } = req.body;

    if (!orgTxnId || !orgRrn || !adjAmount) {
      return res.status(400).json({
        success: false,
        message: 'orgTxnId, orgRrn, and adjAmount are mandatory for complaint refund',
      });
    }

    const payload = {
      pgMerchantId,
      txnId,
      txnNote,
      ts,
      initMode,
      purposeCode,
      refId,
      refUrl,
      complaintTxnId: complaintTxnId || txnId,
      orgTxnId,
      orgRrn,
      orgTxnDate,
      adjAmount: String(adjAmount),
      adjCode: String(adjCode),
    };

    const url = `${CUB_CONFIG.BASE_URL}${CUB_CONFIG.PATH_PREFIX}?serviceName=ReqComplaintRefund&type=ALL&category=ALL&entityName=cub&channelCode=POS&engineName=cags`;
    const result = await sendCubRequest(url, payload, pgMerchantId);

    return res.status(200).json({
      success: true,
      message: 'Complaint refund request initiated successfully',
      data: result.data,
    });
  } catch (err) {
    console.error('❌ complaintRefund error:', err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: err.message || 'Complaint refund failed',
      error: err.response?.data || null,
    });
  }
};

/**
 * 22. Payee Complaint Response to Bank/EPH
 * Service: RespComplaint
 */
exports.payeeComplaintResponse = async (req, res) => {
  try {
    const {
      pgMerchantId = CUB_CONFIG.HEAD_MERCHANT_ID,
      txnId = generateTxnId('PCR'),
      ts = moment().format('YYYY-MM-DDTHH:mm:ss[Z]'),
      txnNote = 'Complaint Response',
      initMode = 'U1',
      purposeCode = '00',
      refId = generateTxnId('REF'),
      refUrl = 'https://ertipay.com',
      complaintTxnId,
      orgTxnId,
      orgRrn,
      orgTxnDate = moment().format('YYYY-MM-DDTHH:mm:ss+05:30'),
      status = 'SUCCESS',
      reqAdjCode = 'U010',
      reqAdjAmount = '2.5',
      reqAdjFlag = 'PBRB',
      adjAmount = '20.00',
      adjCode = '106',
      adjFlag = 'PR2C',
      adjRemarks = 'Goods/services not delivered',
      adjRefId = generateTxnId('ADJ'),
      adjTs = moment().format('YYYY-MM-DDTHH:mm:ss+05:30'),
    } = req.body;

    const payload = {
      pgMerchantId,
      txnId,
      txnNote,
      ts,
      initMode,
      purposeCode,
      refId,
      refUrl,
      complaintTxnId: complaintTxnId || txnId,
      orgTxnId,
      orgRrn,
      orgTxnDate,
      reqAdjCode,
      reqAdjAmount,
      reqAdjFlag,
      adjAmount,
      adjCode,
      adjFlag,
      status,
      adjRemarks,
      adjRefId,
      adjTs,
    };

    const url = `${CUB_CONFIG.BASE_URL}${CUB_CONFIG.PATH_PREFIX}?serviceName=RespComplaint&type=ALL&category=ALL&entityName=cub&channelCode=POS&engineName=cags`;
    const result = await sendCubRequest(url, payload, pgMerchantId);

    return res.status(200).json({
      success: true,
      message: 'Payee complaint response submitted successfully',
      data: result.data,
    });
  } catch (err) {
    console.error('❌ payeeComplaintResponse error:', err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: err.message || 'Payee complaint response failed',
      error: err.response?.data || null,
    });
  }
};

// =========================================================================
// 5. NPCI / KEYS / LITE INTEGRATION APIS
// =========================================================================

/**
 * 23. List Keys Request
 * Service: ListKeys
 */
exports.listKeys = async (req, res) => {
  try {
    const {
      serviceName = 'ListKeys',
      pgMerchantId = CUB_CONFIG.HEAD_MERCHANT_ID,
      vpa = `merchant${CUB_CONFIG.DEFAULT_HANDLE}`,
      txnId = generateTxnId('LKY'),
      txnNote = 'Key Listing',
      ts = moment().format('YYYY-MM-DDTHH:mm:ss[Z]'),
      refId = generateTxnId('REF'),
      refUrl = 'http://www.cityunionbank.com',
      clientVersion = '2.1-01-20330610',
    } = req.body;

    const payload = {
      serviceName,
      pgMerchantId,
      vpa: vpa.trim().toLowerCase(),
      txnId,
      txnNote,
      ts,
      refId,
      refUrl,
      clientVersion,
    };

    const url = `${CUB_CONFIG.BASE_URL}${CUB_CONFIG.PATH_PREFIX}?serviceName=ListKeys&type=ALL&category=ALL&entityName=cub&channelCode=POS&engineName=cags`;
    const result = await sendCubRequest(url, payload, pgMerchantId);

    return res.status(200).json({
      success: true,
      message: 'Keys fetched successfully',
      data: result.data,
    });
  } catch (err) {
    console.error('❌ listKeys error:', err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: err.message || 'Failed to list keys',
      error: err.response?.data || null,
    });
  }
};

/**
 * 24. List Keys Get Token Request
 * Service: GetTokenKey
 */
exports.listKeysGetToken = async (req, res) => {
  try {
    const {
      serviceName = 'GetToken',
      pgMerchantId = CUB_CONFIG.HEAD_MERCHANT_ID,
      vpa = `merchant${CUB_CONFIG.DEFAULT_HANDLE}`,
      txnId = generateTxnId('GTK'),
      txnNote = 'Key Listing GetToken',
      ts = moment().format('YYYY-MM-DDTHH:mm:ss[Z]'),
      refId = generateTxnId('REF'),
      refUrl = 'http://www.cityunionbank.com',
      clientVersion = '2.1-01-20330610',
      credentialType = 'DEVICE',
      credentialSubType = 'IDENTITY',
      keyCode = 'NPCI-LITE',
      ki = '20230322',
      encryptedData = 'sample_encrypted_data',
    } = req.body;

    const payload = {
      serviceName,
      pgMerchantId,
      vpa: vpa.trim().toLowerCase(),
      txnId,
      txnNote,
      ts,
      refId,
      refUrl,
      clientVersion,
      credentialType,
      credentialSubType,
      keyCode,
      ki,
      encryptedData,
    };

    const url = `${CUB_CONFIG.BASE_URL}${CUB_CONFIG.PATH_PREFIX}?serviceName=GetTokenKey&type=ALL&category=ALL&entityName=cub&channelCode=POS&engineName=cags`;
    const result = await sendCubRequest(url, payload, pgMerchantId);

    return res.status(200).json({
      success: true,
      message: 'Token keys fetched successfully',
      data: result.data,
    });
  } catch (err) {
    console.error('❌ listKeysGetToken error:', err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: err.message || 'Failed to get token keys',
      error: err.response?.data || null,
    });
  }
};

/**
 * 25. Get Lite Request
 * Service: GetLite
 */
exports.getLite = async (req, res) => {
  try {
    const {
      serviceName = 'GetLite',
      pgMerchantId = CUB_CONFIG.HEAD_MERCHANT_ID,
      vpa = `merchant${CUB_CONFIG.DEFAULT_HANDLE}`,
      txnId = generateTxnId('GLT'),
      txnNote = 'Get Lite',
      ts = moment().format('YYYY-MM-DDTHH:mm:ss[Z]'),
      refId = generateTxnId('REF'),
      refUrl = 'http://www.cityunionbank.com',
      accountNumber = '500101012220306',
      accountType = 'SAVINGS',
      ifsc = 'CIUB0000625',
      credentialType = 'DEVICE',
      credentialSubType = 'IDENTITY',
      keyCode = 'NPCI-LITE',
      ki = '20230322',
      encryptedData = 'sample_encrypted_data',
    } = req.body;

    const payload = {
      serviceName,
      pgMerchantId,
      vpa: vpa.trim().toLowerCase(),
      txnId,
      txnNote,
      ts,
      refId,
      refUrl,
      accountNumber,
      accountType,
      ifsc,
      credentialType,
      credentialSubType,
      keyCode,
      ki,
      encryptedData,
    };

    const url = `${CUB_CONFIG.BASE_URL}${CUB_CONFIG.PATH_PREFIX}?serviceName=GetLite&type=ALL&category=ALL&entityName=cub&channelCode=POS&engineName=cags`;
    const result = await sendCubRequest(url, payload, pgMerchantId);

    return res.status(200).json({
      success: true,
      message: 'Lite details fetched successfully',
      data: result.data,
    });
  } catch (err) {
    console.error('❌ getLite error:', err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: err.message || 'Failed to get lite details',
      error: err.response?.data || null,
    });
  }
};

// =========================================================================
// 6. CALLBACK / WEBHOOK HANDLERS (EPH TO MERCHANT)
// =========================================================================

/**
 * Generic Callback Handler for CUB Bank Webhooks
 */
exports.handleCallback = async (req, res) => {
  try {
    console.log(`\n🔔 [CUB CALLBACK RECEIVED] Headers:`, req.headers);
    let rawBody = req.body;
    let decryptedPayload = null;

    if (typeof rawBody === 'string') {
      try {
        rawBody = JSON.parse(rawBody);
      } catch {
        // raw text or not valid json
      }
    }

    if (rawBody && rawBody.encdata) {
      decryptedPayload = decryptPayload(rawBody.encdata);
      console.log(`🔓 [CUB CALLBACK DECRYPTED]:`, JSON.stringify(decryptedPayload, null, 2));
    } else {
      decryptedPayload = rawBody;
      console.log(`📩 [CUB CALLBACK PLAIN]:`, JSON.stringify(decryptedPayload, null, 2));
    }

    const txnId = decryptedPayload?.txnId || rawBody?.txnId || 'UNKNOWN';

    // Echo back txnId as required by CUB specifications
    return res.status(200).json({
      txnId: txnId,
    });
  } catch (err) {
    console.error('❌ Callback handling error:', err.message);
    return res.status(200).json({
      txnId: req.body?.txnId || 'ERROR',
      error: err.message,
    });
  }
};

// Export encryption helpers & config
exports.encryptPayload = encryptPayload;
exports.decryptPayload = decryptPayload;
exports.CUB_CONFIG = CUB_CONFIG;
exports.generateTxnId = generateTxnId;
