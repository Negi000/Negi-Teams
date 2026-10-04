// Disable terminal echo, then echo each input byte ourselves exactly once.
process.stdin.setRawMode(true);
process.stdin.on("data", (data) => process.stdout.write(data));
process.stdout.write("PTY_FIXTURE_READY\n");
