/**
 * Utility to expand category names or individual fields into the full set of allowed fields.
 * Ensures that when an employee has approval for any field or section within a category,
 * all fields in that category array are unlocked and editable.
 */

const CATEGORY_DEFINITIONS = [
  {
    name: "personal",
    triggers: ["personal", "dob", "gender", "phone", "emergencyContact", "bloodGroup", "address"],
    fields: ["dob", "gender", "phone", "emergencyContact", "bloodGroup", "address"],
  },
  {
    name: "family",
    triggers: ["family", "siblings", "fatherName", "fatherOccupation", "motherName", "motherOccupation"],
    fields: ["fatherName", "fatherOccupation", "motherName", "motherOccupation", "siblings"],
  },
  {
    name: "working",
    triggers: ["working", "work", "department", "designation", "status", "experience", "salary", "previousExperiences"],
    fields: ["department", "designation", "status", "experience", "salary", "previousExperiences"],
  },
  {
    name: "education",
    triggers: [
      "education", "school10", "marks10", "marksheet10", "certificate10", "passedOutYear10",
      "school12", "marks12", "marksheet12", "certificate12", "passedOutYear12",
      "educationPath", "careerGaps"
    ],
    fields: [
      "school10", "marks10", "marksheet10", "certificate10", "passedOutYear10",
      "school12", "marks12", "marksheet12", "certificate12", "passedOutYear12",
      "educationPath", "careerGaps",
    ],
  },
  {
    name: "courses",
    triggers: ["courses", "course", "degreeCertificate"],
    fields: ["courses", "degreeCertificate"],
  },
  {
    name: "kycBank",
    triggers: [
      "kyc", "bank", "aadhaarNo", "panNo", "aadhaarFile", "panFile",
      "bankName", "accountHolder", "accountNumber", "ifscCode", "branch", "toDate", "passbookFile"
    ],
    fields: [
      "aadhaarNo", "panNo", "aadhaarFile", "panFile",
      "bankName", "accountHolder", "accountNumber", "ifscCode", "branch", "toDate", "passbookFile"
    ],
  },
  {
    name: "documents",
    triggers: ["documents", "document", "uploadDocument", "picture"],
    fields: [
      "picture", "aadhaarFile", "panFile", "marksheet10", "marksheet12",
      "courses", "degreeCertificate", "passbookFile"
    ],
  },
];

const expandAllowedFields = (rawFields) => {
  if (!Array.isArray(rawFields) || rawFields.length === 0) return [];
  if (rawFields.includes("ALL")) return ["ALL"];

  const expanded = new Set(rawFields);

  CATEGORY_DEFINITIONS.forEach((cat) => {
    const hasTrigger = cat.triggers.some((t) => rawFields.includes(t));
    if (hasTrigger) {
      cat.fields.forEach((f) => expanded.add(f));
      expanded.add(cat.name);
      if (cat.name === "family") expanded.add("siblings");
      if (cat.name === "working") expanded.add("work");
      if (cat.name === "kycBank") {
        expanded.add("kyc");
        expanded.add("bank");
      }
    }
  });

  return Array.from(expanded);
};

module.exports = {
  CATEGORY_DEFINITIONS,
  expandAllowedFields,
};
