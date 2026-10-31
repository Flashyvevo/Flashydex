const pid = Number(process.argv[2]);
if (!Number.isInteger(pid)) {
  throw new Error("Expected a numeric process ID");
}
process.kill(pid);
console.log(`Sent termination signal to ${pid}`);
