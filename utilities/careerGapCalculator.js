
function getCourseJoiningYear(course) {
  if (!course) return null;
  if (course.joiningYear !== undefined && course.joiningYear !== null && course.joiningYear !== "") {
    const y = parseInt(String(course.joiningYear).trim(), 10);
    if (!isNaN(y) && y >= 1950 && y <= 2100) return y;
  }
  if (course.passedOutYear && typeof course.passedOutYear === "string") {
    const s = course.passedOutYear.trim();
    const match = s.match(/^(\d{4})\s*-\s*(\d{4})$/);
    if (match) {
      const y = parseInt(match[1], 10);
      if (!isNaN(y) && y >= 1950 && y <= 2100) return y;
    }
  }
  return null;
}

function calculateEligibleCareerGaps({
  passedOutYear10,
  passedOutYear12,
  educationPath,
  courses = [],
}) {
  const y10Num = parseInt(String(passedOutYear10 || "").trim(), 10);
  const valid10 = !isNaN(y10Num) && y10Num >= 1950 && y10Num <= 2100;
  if (!valid10) return [];

  const y12Num = parseInt(String(passedOutYear12 || "").trim(), 10);
  const valid12 = !isNaN(y12Num) && y12Num >= 1950 && y12Num <= 2100;

  const courseList = Array.isArray(courses) ? courses : [];
  const diplomaCourse = courseList.find(
    (c) => c && String(c.courseType || "").trim().toUpperCase() === "DIPLOMA"
  );
  const ugCourse = courseList.find(
    (c) =>
      c &&
      (String(c.courseType || "").trim().toUpperCase() === "UG" ||
        String(c.courseType || "").trim().toUpperCase() === "ENGINEERING")
  );

  const isDiplomaPath = String(educationPath || "").trim().toLowerCase() === "diploma";
  // If the student's education path after 10th is Diploma, 12th is not part of their education path
  const effectiveValid12 = !isDiplomaPath && valid12;

  const gaps = [];

  // Path 1: 10th -> 12th -> Diploma -> Engineering (or 10th -> 12th -> Diploma)
  if (effectiveValid12 && Boolean(diplomaCourse)) {
    const expected12th = y10Num + 2;
    const gapYears = y12Num - expected12th;
    if (gapYears > 0) {
      gaps.push({
        educationStage: "10th to 12th Standard",
        passedOutYear10: String(y10Num),
        expectedYear12: String(expected12th),
        actualYear12: String(y12Num),
        gapDuration: gapYears,
      });
    }

    const diplomaJoiningYear = getCourseJoiningYear(diplomaCourse);
    if (diplomaJoiningYear !== null) {
      const expectedDiploma = y12Num;
      const gapYearsDiploma = diplomaJoiningYear - expectedDiploma;
      if (gapYearsDiploma > 0) {
        gaps.push({
          educationStage: "12th Standard to Diploma",
          passedOutYear12: String(y12Num),
          expectedDiplomaYear: String(expectedDiploma),
          actualDiplomaYear: String(diplomaJoiningYear),
          actualYear12: String(y12Num),
          gapDuration: gapYearsDiploma,
        });
      }
    }

    if (ugCourse) {
      const ugJoiningYear = getCourseJoiningYear(ugCourse);
      let diplomaEndYear = null;
      if (diplomaCourse.passedOutYear) {
        const m = String(diplomaCourse.passedOutYear).match(/^(\d{4})\s*-\s*(\d{4})$/);
        if (m) diplomaEndYear = parseInt(m[2], 10);
      }
      if (ugJoiningYear !== null && diplomaEndYear !== null) {
        const gapYearsUG = ugJoiningYear - diplomaEndYear;
        if (gapYearsUG > 0) {
          gaps.push({
            educationStage: "Diploma to UG / Engineering",
            passedOutYearDiploma: String(diplomaEndYear),
            expectedUGYear: String(diplomaEndYear),
            actualUGYear: String(ugJoiningYear),
            gapDuration: gapYearsUG,
          });
        }
      }
    }
  }
  // Path 2: 10th -> 12th -> UG/Engineering
  // Apply Rule A and Rule B.
  else if (effectiveValid12 && !diplomaCourse) {
    // Rule A: 10th to 12th Standard
    const expected12th = y10Num + 2;
    const gapYearsA = y12Num - expected12th;
    if (gapYearsA > 0) {
      gaps.push({
        educationStage: "10th to 12th Standard",
        passedOutYear10: String(y10Num),
        expectedYear12: String(expected12th),
        actualYear12: String(y12Num),
        gapDuration: gapYearsA,
      });
    }

    // Rule B: 12th Standard to UG / Engineering
    if (ugCourse) {
      const ugJoiningYear = getCourseJoiningYear(ugCourse);
      if (ugJoiningYear !== null) {
        const expectedUG = y12Num;
        const gapYearsB = ugJoiningYear - expectedUG;
        if (gapYearsB > 0) {
          gaps.push({
            educationStage: "12th Standard to UG / Engineering",
            passedOutYear12: String(y12Num),
            expectedUGYear: String(expectedUG),
            actualUGYear: String(ugJoiningYear),
            actualYear12: String(y12Num),
            gapDuration: gapYearsB,
          });
        }
      }
    }
  }
  // Path 3: 10th -> Diploma -> Engineering or 10th -> Diploma
  // Apply Rule C only.
  else if (isDiplomaPath || (!effectiveValid12 && Boolean(diplomaCourse))) {
    if (diplomaCourse) {
      const diplomaJoiningYear = getCourseJoiningYear(diplomaCourse);
      if (diplomaJoiningYear !== null) {
        const expectedDiploma = y10Num;
        const gapYearsC = diplomaJoiningYear - expectedDiploma;
        if (gapYearsC > 0) {
          gaps.push({
            educationStage: "10th to Diploma",
            passedOutYear10: String(y10Num),
            expectedDiplomaYear: String(expectedDiploma),
            actualDiplomaYear: String(diplomaJoiningYear),
            actualYear12: String(diplomaJoiningYear),
            gapDuration: gapYearsC,
          });
        }
      }

      if (ugCourse) {
        const ugJoiningYear = getCourseJoiningYear(ugCourse);
        let diplomaEndYear = null;
        if (diplomaCourse.passedOutYear) {
          const m = String(diplomaCourse.passedOutYear).match(/^(\d{4})\s*-\s*(\d{4})$/);
          if (m) diplomaEndYear = parseInt(m[2], 10);
        }
        if (ugJoiningYear !== null && diplomaEndYear !== null) {
          const gapYearsUG = ugJoiningYear - diplomaEndYear;
          if (gapYearsUG > 0) {
            gaps.push({
              educationStage: "Diploma to UG / Engineering",
              passedOutYearDiploma: String(diplomaEndYear),
              expectedUGYear: String(diplomaEndYear),
              actualUGYear: String(ugJoiningYear),
              gapDuration: gapYearsUG,
            });
          }
        }
      }
    }
  }

  return gaps;
}

module.exports = {
  getCourseJoiningYear,
  calculateEligibleCareerGaps,
};
