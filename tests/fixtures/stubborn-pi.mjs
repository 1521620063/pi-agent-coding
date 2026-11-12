import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
if (process.argv.includes("--version")) {
  console.log("fake-pi 1.5.2");
  process.exit(0);
}
const descendant = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
  stdio: "ignore",
  windowsHide: true,
});
setInterval(() => {}, 1000);
createInterface({ input: process.stdin }).on("line", (line) => {
  const cmd = JSON.parse(line);
  process.stdout.write(
    JSON.stringify({
      id: cmd.id,
      type: "response",
      command: cmd.type,
      success: true,
      data: { sessionId: "stubborn", childPid: descendant.pid },
    }) + "\n",
  );
});
