// Trusted external assertions. Candidate code runs in a subprocess and cannot
// replace this parent's result writer. Nonzero exit here means inconclusive.
const { spawnSync } = require("node:child_process");
const cases = [
  { id: "positive", a: 2, b: 3, expected: 5 },
  { id: "negative", a: -2, b: -3, expected: -5 },
  { id: "zero", a: 0, b: 0, expected: 0 }
];
const assertions = cases.map(({ id, a, b, expected }) => {
  const child = spawnSync(process.execPath, ["-e",
    `process.stdout.write(JSON.stringify(require('/workspace/math.cjs').add(${a},${b})))`
  ], { encoding: "utf8", timeout: 1000, maxBuffer: 65536 });
  return { id, passed: child.status === 0 && child.stdout === JSON.stringify(expected) };
});
process.stdout.write(JSON.stringify({ version: 1, assertions }));
