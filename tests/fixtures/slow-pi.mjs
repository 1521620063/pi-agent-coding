if (process.argv.includes("--version")) {
  setTimeout(() => {
    console.log("slow-pi 1.5.2");
    process.exit(0);
  }, 2000);
} else {
  process.stdin.resume();
  setInterval(() => {}, 1000);
}
