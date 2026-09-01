import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  process.exit(0);
}

const text = fs.readFileSync(file, "utf8");
const parsed = JSON.parse(text);
fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
