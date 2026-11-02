// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "coverage"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["eslint.config.js"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  { files: ["eslint.config.js"], ...tseslint.configs.disableTypeChecked },
  {
    files: ["test/**"],
    rules: { "@typescript-eslint/require-await": "off", "@typescript-eslint/no-non-null-assertion": "off" },
  },
);
