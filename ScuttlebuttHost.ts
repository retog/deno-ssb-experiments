import Transport from "./comm/transport/Transport.ts";
import NetTransport from "./comm/transport/NetTransport.ts";
import BoxInterface from "./comm/box/BoxInterface.ts";
import RpcInterface from "./comm/rpc/RpcInterface.ts";
import RpcMethodsHandler from "./comm/rpc/RpcMethodsHandler.ts";
import { FeedId, fromBase64, log, path, sodium, toBase64 } from "./util.ts";
import Agent from "./agents/Agent.ts";
import FeedsAgent from "./agents/feeds/FeedsAgent.ts";
import BlobsAgent from "./agents/blobs/BlobsAgent.ts";
import WsTransport from "./comm/transport/WsTransport.ts";
import FsStorage from "./storage/FsStorage.ts";

/** A host communicating to peers using the Secure Scuttlebutt protocol */
export default class ScuttlebuttHost {
  readonly transports = new Set<Transport>();

  feedsAgent: FeedsAgent;
  blobsAgent: BlobsAgent;

  constructor(
    readonly config: {
      transport?: { net?: { port: number } };
      autoConnectLocalPeers?: boolean;
      acceptIncomingConnections?: boolean;
      baseDir: string;
      dataDir: string;
      networkIdentifier?: string;
    },
  ) {
    const fsStorage = new FsStorage(config.dataDir);
    this.feedsAgent = new FeedsAgent(fsStorage, config.baseDir);
    this.blobsAgent = new BlobsAgent(fsStorage);
    this.addTransport(
      new NetTransport(config.transport?.net),
    );
    this.addTransport(
      new WsTransport(),
    );
    if (config.autoConnectLocalPeers) {
      /*  for await (const peer of udpPeerDiscoverer) {
        if (
          JSON.stringify(peerAddresses.get(peer.hostname)) !==
            JSON.stringify(peer.addresses)
        ) {
          peerAddresses.set(peer.hostname, peer.addresses);
          console.log(peer.addresses);
          //TODO check if bcm already has connection to peer, otherwise connect.
        }
      }
      */
    }
  }

  addTransport(transport: Transport) {
    this.transports.add(transport);
  }

  async start() {
    log.info(`Starting SSB Host`);
    const agents: Agent[] = this.getAgents();
    const boxInterface = new BoxInterface(
      [
        ...new Set(this.transports.values()),
      ],
      getClientKeyPair(this.config.baseDir),
      this.config.networkIdentifier
        ? fromBase64(this.config.networkIdentifier)
        : undefined,
    );
    //there are incoming connections, connections established explicitely by user, connections initiated by the feeds- or blobs-subsystem
    //incoming procedures call are handled by a RequestHandler provided by the subsystem for a specific peer
    //subsystem can send request over any connection and are notified on new connectins
    const rpcInterface = new RpcInterface(
      (feedId: FeedId) =>
        new RpcMethodsHandler(
          agents.map((agent) => agent.createRpcContext(feedId)),
        ),
      boxInterface,
    );
    agents.forEach((agent) => agent.start(rpcInterface));
    if (
      this.config.acceptIncomingConnections
    ) {
      log.info("listening for incoming connections");
      for await (const rpcConnection of rpcInterface.listen()) {
        Promise.all(
          agents.map((agent) => agent.incomingConnection(rpcConnection)),
        );
      }
    }
  }

  getAgents() {
    return [this.feedsAgent, this.blobsAgent];
  }
}

function getClientKeyPair(baseDir: string) {
  const secretFilePath = path.join(baseDir, "secret");
  try {
    const secretText = Deno.readTextFileSync(secretFilePath);
    const secretTextNoComments = secretText.split("\n").filter((line) =>
      line.charAt(0) !== "#"
    ).join("\n");
    const secret = JSON.parse(secretTextNoComments);
    return {
      keyType: secret.curve,
      publicKey: fromBase64(
        secret.public.substring(0, secret.public.length - ".ed25519".length),
      ),
      privateKey: fromBase64(
        secret.private.substring(0, secret.private.length - ".ed25519".length),
      ),
    };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      const newKey = sodium.crypto_sign_keypair("uint8array");
      const secret = {
        public: toBase64(newKey.publicKey) + ".ed25519",
        "private": toBase64(newKey.privateKey) + ".ed25519",
        curve: newKey.keyType,
      };
      Deno.mkdirSync(baseDir, { recursive: true });
      Deno.writeTextFileSync(
        secretFilePath,
        JSON.stringify(secret, undefined, 2),
      );
      return newKey;
    } else {
      // unexpected error, pass it along
      throw error;
    }
  }
}
