const puppeteer = require("puppeteer");
const fs = require("fs");

let browser = null;
let browserPromise = null;

const getExecutablePath = () => {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const candidatePaths = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium"
  ];

  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      try {
        const stats = fs.statSync(p);
        if (stats.size > 0) return p;
      } catch (e) {
        // ignore
      }
    }
  }

  return undefined;
};

const closeBrowser = async () => {
  if (browser) {
    try {
      await browser.close();
    } catch (e) {
      // ignore
    }
    browser = null;
  }
  browserPromise = null;
};

const getBrowser = async () => {
  if (browser && typeof browser.isConnected === "function" && browser.isConnected()) {
    return browser;
  }

  if (browserPromise) {
    return browserPromise;
  }

  browserPromise = (async () => {
    try {
      const execPath = getExecutablePath();
      const baseArgs = [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-default-apps",
        "--disable-sync",
        "--disable-translate",
        "--mute-audio",
        "--no-default-browser-check"
      ];

      if (process.platform === "linux") {
        baseArgs.push("--no-zygote");
      }

      const launchOptions = {
        headless: true,
        args: baseArgs
      };

      if (execPath) {
        launchOptions.executablePath = execPath;
      }

      let b;
      try {
        b = await puppeteer.launch(launchOptions);
      } catch (launchErr) {
        if (launchOptions.executablePath) {
          console.warn("Failed to launch browser with specified executablePath, retrying with default puppeteer browser...", launchErr.message);
          const fallbackOptions = { ...launchOptions };
          delete fallbackOptions.executablePath;
          b = await puppeteer.launch(fallbackOptions);
        } else {
          throw launchErr;
        }
      }

      browser = b;
      b.on("disconnected", () => {
        if (browser === b) {
          browser = null;
          browserPromise = null;
        }
      });
      return b;
    } catch (err) {
      browserPromise = null;
      throw err;
    }
  })();

  return browserPromise;
};

// Sequential task queue to prevent multiple concurrent Chromium instances from exhausting RAM on low-spec servers
let queuePromise = Promise.resolve();

const queueTask = (task) => {
  const next = queuePromise.then(() => task(), () => task());
  queuePromise = next.catch(() => { });
  return next;
};

const generatePayslipPdf = async (html) => {
  return queueTask(async () => {
    const attemptGenerate = async () => {
      const browserInstance = await getBrowser();
      const page = await browserInstance.newPage();
      await page.setCacheEnabled(true);
      try {
        await page.setContent(html, {
          waitUntil: "domcontentloaded",
          timeout: 30000
        });

        const pdfBuffer = await page.pdf({
          format: "A4",
          printBackground: true,
          preferCSSPageSize: true
        });

        return pdfBuffer;
      } finally {
        if (page) {
          try {
            await page.close();
          } catch (e) {
            // ignore
          }
        }
      }
    };

    try {
      return await attemptGenerate();
    } catch (err) {
      console.warn("PDF Generation failed on first try, resetting browser and retrying...", err.message);
      await closeBrowser();
      return await attemptGenerate();
    }
  });
};

// Cleanup on exit
process.on("SIGINT", closeBrowser);
process.on("SIGTERM", closeBrowser);

module.exports = generatePayslipPdf;