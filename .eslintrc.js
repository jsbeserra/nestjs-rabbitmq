/* eslint-disable no-undef */
module.exports = {
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint","sonarjs"],
  root: true,
  rules: {
    "@typescript-eslint/no-explicit-any": "off",
    "no-unused-vars": "off",
    "@typescript-eslint/no-unused-vars": [
      "warn", // or "error"
      {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      },
    ],
    "sonarjs/no-all-duplicated-branches": "error",
    "sonarjs/no-element-overwrite": "error",
    "sonarjs/no-empty-collection": "error",
    "sonarjs/no-collection-size-mischeck": "error",
    "sonarjs/no-nested-switch": "error",
    "sonarjs/no-nested-template-literals": "warn",
    "sonarjs/no-unused-collection": "error", 
    "sonarjs/no-use-of-empty-return-value": "warn",
    "sonarjs/prefer-immediate-return": "warn", 
    "sonarjs/prefer-single-boolean-return": "warn", 
    "sonarjs/prefer-immediate-return": "warn"
  },
};
