import ScuttlebuttPeer from "./ScuttlebuttPeer.ts";
import BoxConnection from "./BoxConnection.ts";
import Procedures from "./Procedures.ts";
import { updateFeeds } from "./feedSubscriptions.ts";
import { Address, delay, log, parseAddress, path } from "./util.ts";
import RPCConnection from "./RPCConnection.ts";
import config from "./config.ts";

const peersFile = path.join(config.baseDir, "peers.json");

function getPeersFromFile() {
  try {
    return JSON.parse(Deno.readTextFileSync(peersFile));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return [];
    }
    throw error;
  }
}

function getPeers() {
  return getPeersFromFile().map(parseAddress);
}

const peers: Address[] = getPeers();

const host = new ScuttlebuttPeer();

host.listen();

host.addEventListener("connected", async (options) => {
  log.debug("new connection");
  const boxConnection: BoxConnection = (options as CustomEvent).detail;
  const rpcConnection = new RPCConnection(boxConnection, new Procedures());
  await updateFeeds(rpcConnection);
});
let initialDelaySec = 0;
await Promise.all(peers.map((address) =>
  (async () => {
    initialDelaySec += 10;
    await delay(initialDelaySec * 1000);
    let minutesDelay = 1;
    while (true) {
      try {
        if (host.connections.length > 20) {
          log.info("More than 20 connections open, standing by.");
        } else {
          log.info(
            `${host.connections.length} connections open, connecting to ${address}`,
          );
          await host.connect(address);
        }
      } catch (error) {
        log.error(
          `In connection with ${address}: ${error}, now having ${host.connections.length} connections left`,
        );
        log.info(`stack: ${error.stack}`);
        minutesDelay++;
      }
      await delay(minutesDelay * 60 * 1000);
    }
  })()
));
