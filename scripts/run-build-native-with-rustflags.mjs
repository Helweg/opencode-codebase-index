import { spawn } from "child_process";

const child = spawn("npm run build:native", {
  stdio: "inherit",
  shell: true,
  env: {
    ...process.env,
    RUSTFLAGS: "-C target-cpu=generic",
  },
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
