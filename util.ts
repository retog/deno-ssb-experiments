export function parseAddress(addr: string) {
  const sections = addr.split(":");
  const [protocol, host, portshs, key] = sections;
  const port = parseInt(portshs.split("~")[0]);
  return { protocol, host, port, key };
}

export function bytes2NumberUnsigned(bytes: Uint8Array): number {
  return bytes.length === 0 ? 0 : bytes[0] * Math.pow(0x100, bytes.length - 1) +
    bytes2NumberUnsigned(bytes.subarray(1));
}

export function bytes2NumberSigned(bytes: Uint8Array): number {
  return bytes[0] & 0b10000000
    ? -Math.pow(2, 7 + (bytes.length - 1) * 8) + (0b01111111 &
          bytes[0]) * Math.pow(0x100, bytes.length - 1) +
      bytes2NumberUnsigned(bytes.subarray(1))
    : bytes2NumberUnsigned(bytes);
}

export function concat(...elems: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    elems.reduce((sum, elem) => sum + (elem.length), 0),
  );
  let pos = 0;
  for (const elem of elems) {
    result.set(elem, pos);
    pos += elem.length;
  }
  return result;
}

export async function readBytes(reader: Deno.Reader, length: number) {
  const result = new Uint8Array(length);
  let bytesRead = 0;
  while (bytesRead < length) {
    const remainder = result.subarray(bytesRead);
    const bytesReadNow = await reader.read(remainder);
    if (bytesReadNow === null) {
      throw new Error("End of reader");
    }
    bytesRead += bytesReadNow;
    if (bytesRead !== length) {
      console.info(
        `Outstanding data: expecting ${length} bytes but got only ${bytesRead} so far`,
      );
    }
  }
  return result;
}
