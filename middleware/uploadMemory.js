const multer = require("multer");

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {

    const allowedTypes = [
      // Images
      "image/jpeg",
      "image/png",
      "image/jpg",
      "image/webp",
      "image/heic",
      "image/heif",

      // Documents
      "application/pdf",
      "text/plain",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",

      // Excel / Spreadsheets
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel.sheet.macroEnabled.12",
      "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
      "application/vnd.oasis.opendocument.spreadsheet",
      "text/csv",

      // ZIP Files
      "application/zip",
      "application/x-zip-compressed",
      "multipart/x-zip",
      "application/octet-stream"
    ];

    const isAllowedExt = /\.(xlsx|xls|csv|xlsm|xlsb|ods|pdf|doc|docx|txt|zip|png|jpg|jpeg|webp|heic|heif)$/i.test(file.originalname);

    if (allowedTypes.includes(file.mimetype) || isAllowedExt) {
      return cb(null, true);
    }

    return cb(new Error("File type not allowed"), false);
  }
});

module.exports = upload;