// deno-lint-ignore-file camelcase
import sodium from "https://deno.land/x/sodium@0.2.0/sumo.ts";
import {
  Address,
  combine,
  concat,
  FeedId,
  fromBase64,
  log,
  path,
  readBytes,
  toBase64,
} from "../../util.ts";
import BoxConnection from "./BoxConnection.ts";
import config from "../../config.ts";
import NetTransport from "../transport/NetTransport.ts";
import CommInterface from "../CommInterface.ts";

/** A peer with an identity and the abity to connect to other peers using the Secure Scuttlebutt Handshake */
export default class BoxInterface implements CommInterface<BoxConnection> {
  network_identifier = config.networkIdentifier;
  keyPair = getClientKeyPair();
  id = new FeedId(this.keyPair.publicKey);

  netTransport = new NetTransport();

  constructor(
    public readonly underlying: CommInterface<
      Deno.Reader & Deno.Writer & Deno.Closer
    >[],
  ) {}

  connections: BoxConnection[] = [];

  /** perform handshake as client */
  async connect(
    address: Address,
  ) {
    // deno-lint-ignore no-this-alias
    const _host = this;
    const clientEphemeralKeyPair = sodium.crypto_box_keypair("uint8array");
    const conn = await this.netTransport.connect(address);

    const clientHello = () => {
      const hmac = sodium.crypto_auth(
        clientEphemeralKeyPair.publicKey,
        this.network_identifier,
      );
      return concat(hmac, clientEphemeralKeyPair.publicKey);
    };

    const authenticate = async (
      server_longterm_pk: Uint8Array,
      shared_secret_ab: Uint8Array,
      shared_secret_aB: Uint8Array,
    ) => {
      // 3. Client authenticate
      const shared_secret_ab_sha256 = sodium.crypto_hash_sha256(
        shared_secret_ab,
      );
      const msg = concat(
        this.network_identifier,
        server_longterm_pk,
        shared_secret_ab_sha256,
      );
      const detached_signature_A = sodium.crypto_sign_detached(
        msg,
        this.keyPair.privateKey,
      );
      const boxMsg = new Uint8Array(
        detached_signature_A.length +
          this.keyPair.publicKey.length,
      );
      boxMsg.set(detached_signature_A);
      boxMsg.set(
        this.keyPair.publicKey,
        detached_signature_A.length,
      );
      const nonce = new Uint8Array(24);
      const boxKey = sodium.crypto_hash_sha256(
        concat(this.network_identifier, shared_secret_ab, shared_secret_aB),
      );
      await conn.write(sodium.crypto_secretbox_easy(boxMsg, nonce, boxKey));
      return detached_signature_A;
    };

    const hello = clientHello();
    await conn.write(hello);
    const serverResponse = await readBytes(conn, 64);
    const server_hmac = serverResponse.subarray(0, 32);
    const server_ephemeral_pk = serverResponse.subarray(32, 64);
    if (
      !sodium.crypto_auth_verify(
        server_hmac,
        server_ephemeral_pk,
        this.network_identifier,
      )
    ) {
      throw new Error("Verification of the server's first response failed");
    }
    const shared_secret_ab = sodium.crypto_scalarmult(
      clientEphemeralKeyPair.privateKey,
      server_ephemeral_pk,
    );

    const shared_secret_aB = sodium.crypto_scalarmult(
      clientEphemeralKeyPair.privateKey,
      sodium.crypto_sign_ed25519_pk_to_curve25519(address.key),
    );
    const server_longterm_pk = address.key;
    const detached_signature_A = await authenticate(
      server_longterm_pk,
      shared_secret_ab,
      shared_secret_aB,
    );

    const shared_secret_Ab = sodium.crypto_scalarmult(
      sodium.crypto_sign_ed25519_sk_to_curve25519(
        this.keyPair.privateKey,
      ),
      server_ephemeral_pk,
    );

    const serverResponse2 = await readBytes(conn, 80); //msg4 in protocol guide

    const detached_signature_B = sodium.crypto_box_open_easy_afternm(
      serverResponse2,
      new Uint8Array(24),
      sodium.crypto_hash_sha256(
        concat(
          this.network_identifier,
          shared_secret_ab,
          shared_secret_aB,
          shared_secret_Ab,
        ),
      ),
    );

    const verification2 = sodium.crypto_sign_verify_detached(
      detached_signature_B,
      concat(
        this.network_identifier,
        detached_signature_A,
        this.keyPair.publicKey,
        sodium.crypto_hash_sha256(shared_secret_ab),
      ),
      server_longterm_pk,
    );

    if (!verification2) {
      throw new Error("Verification of the server's second response failed");
    }

    const combinedSharedSecret = sodium.crypto_hash_sha256(
      sodium.crypto_hash_sha256(
        concat(
          this.network_identifier,
          shared_secret_ab,
          shared_secret_aB,
          shared_secret_Ab,
        ),
      ),
    );

    const connection = new BoxConnection(
      conn,
      combinedSharedSecret,
      this.keyPair.publicKey,
      server_longterm_pk,
      clientEphemeralKeyPair.publicKey,
      server_ephemeral_pk,
    );
    this.connections.push(connection);
    connection.addEventListener("close", () => {
      log.debug(
        `closed outbound connection, one of ${this.connections.length}`,
      );
      this.connections = this.connections.filter((c) => c !== connection);
    });
    return connection;
  }

  /** perform handshake as server */
  async acceptConnection(
    conn: Deno.Reader & Deno.Writer & Deno.Closer,
  ): Promise<BoxConnection> {
    const serverEphemeralKeyPair = sodium.crypto_box_keypair("uint8array");
    const clientHello = await readBytes(conn, 64);
    const client_hmac = clientHello.subarray(0, 32);
    const client_ephemeral_pk = clientHello.subarray(32, 64);
    if (
      !sodium.crypto_auth_verify(
        client_hmac,
        client_ephemeral_pk,
        this.network_identifier,
      )
    ) {
      throw new Error("Verification of the client's hello failed");
    }
    const serverHello = concat(
      sodium.crypto_auth(
        serverEphemeralKeyPair.publicKey,
        this.network_identifier,
      ),
      serverEphemeralKeyPair.publicKey,
    );
    await conn.write(serverHello);
    const shared_secret_ab = sodium.crypto_scalarmult(
      serverEphemeralKeyPair.privateKey,
      client_ephemeral_pk,
    );

    const shared_secret_aB = sodium.crypto_scalarmult(
      sodium.crypto_sign_ed25519_sk_to_curve25519(
        this.keyPair.privateKey,
      ),
      client_ephemeral_pk,
    );

    const msg3 = await readBytes(conn, 112);

    const msg3_plaintext = sodium.crypto_secretbox_open_easy(
      msg3,
      new Uint8Array(24),
      sodium.crypto_hash_sha256(
        concat(
          this.network_identifier,
          shared_secret_ab,
          shared_secret_aB,
        ),
      ),
    );

    if (msg3_plaintext.length !== 96) {
      throw Error("Invalid message length");
    }

    const detached_signature_A = msg3_plaintext.subarray(0, 64);
    const client_longterm_pk = msg3_plaintext.subarray(64, 96);

    const verification3 = sodium.crypto_sign_verify_detached(
      detached_signature_A,
      concat(
        this.network_identifier,
        this.keyPair.publicKey,
        sodium.crypto_hash_sha256(shared_secret_ab),
      ),
      client_longterm_pk,
    );
    if (!verification3) {
      throw new Error("Verification of the client's third message failed");
    }

    const shared_secret_Ab = sodium.crypto_scalarmult(
      serverEphemeralKeyPair.privateKey,
      sodium.crypto_sign_ed25519_pk_to_curve25519(client_longterm_pk),
    );
    const detached_signature_B = sodium.crypto_sign_detached(
      concat(
        this.network_identifier,
        detached_signature_A,
        client_longterm_pk,
        sodium.crypto_hash_sha256(shared_secret_ab),
      ),
      this.keyPair.privateKey,
    );
    const completionMsg = sodium.crypto_secretbox_easy(
      detached_signature_B,
      new Uint8Array(24),
      sodium.crypto_hash_sha256(
        concat(
          this.network_identifier,
          shared_secret_ab,
          shared_secret_aB,
          shared_secret_Ab,
        ),
      ),
    );
    await conn.write(completionMsg);

    const combinedSharedSecret = sodium.crypto_hash_sha256(
      sodium.crypto_hash_sha256(
        concat(
          this.network_identifier,
          shared_secret_ab,
          shared_secret_aB,
          shared_secret_Ab,
        ),
      ),
    );

    const connection = new BoxConnection(
      conn,
      combinedSharedSecret,
      this.keyPair.publicKey,
      client_longterm_pk,
      serverEphemeralKeyPair.publicKey,
      client_ephemeral_pk,
    );
    this.connections.push(connection);
    connection.addEventListener("close", () => {
      log.debug(
        `closed incoming connection, one of ${this.connections.length}`,
      );
      this.connections = this.connections.filter((c) => c !== connection);
    });
    return connection;
  }

  async *listen() {
    const iterator = combine(
      ...this.underlying.map((i) => i.listen()),
    );
    for await (
      const conn of {
        [Symbol.asyncIterator]: () => iterator,
      }
    ) {
      try {
        yield await this.acceptConnection(conn);
      } catch (error) {
        log.warning(
          `Error with incoming connection  ${JSON.stringify(conn)}: ${error}`,
        );
      }
    }
  }
}

function getClientKeyPair() {
  const secretFileDir = config.baseDir;
  const secretFilePath = path.join(secretFileDir, "secret");
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
      Deno.mkdirSync(secretFileDir, { recursive: true });
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