import SsbHost, { RpcBodyType } from "./SsbHost.ts";
import { parseAddress } from "./util.ts";
//import udpPeerDiscoverer from "./udpPeerDiscoverer.ts";

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const host = new SsbHost();

if (Deno.args.length !== 1) {
  throw new Error("expecting exactly one argument");
}

const addressString = Deno.args[0]; // "net:172.17.0.2:8008~shs:bEhA+VRRIf8mTO474KlSuYTObJACRYZqkwxCl4Id4fk="
const address = parseAddress(
  addressString,
);

const boxConnection = await host.connect(
  address,
);
async function monitorConnection() {
  let i = 0;
  for await (const message of boxConnection) {
    console.log(i++, message);
    console.log("as text", decoder.decode(message));
  }
}

monitorConnection();

console.log("sending a message...");
/*boxConnection.sendRpcMessage({
  "name": ["blobs", "createWants"],
  "args": [],
  "type": "source",
}, {
  bodyType: RpcBodyType.json,
});*/

boxConnection.sendRpcMessage({
  "name": ["createHistoryStream"],
  "type": "source",
  "args": [{ "id": `@${address.key}.ed25519` }],
}, {
  bodyType: RpcBodyType.json,
  isStream: true,
});
