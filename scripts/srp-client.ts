// Test helper: runs the SRP client against a server's salt/B given as hex args.
import { SrpClient } from "../src/lib/companion/srp";

const [pin, saltHex, bHex] = process.argv.slice(2);
const client = new SrpClient("Pair-Setup", pin);
const m1 = client.process(Buffer.from(saltHex, "hex"), Buffer.from(bHex, "hex"));
console.log(
  JSON.stringify({ A: client.publicKey.toString("hex"), M1: m1.toString("hex"), K: client.sessionKey.toString("hex") }),
);
// Optional 4th arg: server proof (M2) to verify.
if (process.argv[5]) console.log(JSON.stringify({ m2ok: client.verifyServerProof(Buffer.from(process.argv[5], "hex")) }));
