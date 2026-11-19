import dgram from "node:dgram";
import net from "node:net";

/**
 * Stands in for DNS, so domain verification runs through the plugin's real resolver. Answers
 * TXT questions from a table and NXDOMAIN for anything else. Tests set a name's TXT values
 * through a control socket, with `setTxt`, since they run in other workers.
 */
export const DNS_PORT = 2591;
const CONTROL_PORT = 2592;

function questionEnd(message: Buffer): number {
  let offset = 12;
  while (offset < message.length && message[offset] !== 0) offset += message[offset] + 1;
  return offset + 5;
}

function questionName(message: Buffer): string {
  const labels: string[] = [];
  let offset = 12;
  while (offset < message.length && message[offset] !== 0) {
    labels.push(message.subarray(offset + 1, offset + 1 + message[offset]).toString("ascii"));
    offset += message[offset] + 1;
  }
  return labels.join(".").toLowerCase();
}

function answer(query: Buffer, records: Map<string, string[]>): Buffer {
  const end = questionEnd(query);
  const type = query.readUInt16BE(end - 4);
  const values = type === 16 ? records.get(questionName(query)) : undefined;
  const header = Buffer.alloc(12);
  query.copy(header, 0, 0, 2);
  header.writeUInt16BE(values ? 0x8180 : 0x8183, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(values?.length ?? 0, 6);
  const answers = (values ?? []).map((value) => {
    const text = Buffer.from(value, "utf8");
    const record = Buffer.alloc(12);
    record.writeUInt16BE(0xc00c, 0);
    record.writeUInt16BE(16, 2);
    record.writeUInt16BE(1, 4);
    record.writeUInt32BE(0, 6);
    record.writeUInt16BE(text.length + 1, 10);
    return Buffer.concat([record, Buffer.from([text.length]), text]);
  });
  return Buffer.concat([header, query.subarray(12, end), ...answers]);
}

export function startDns() {
  const records = new Map<string, string[]>();
  const udp = dgram.createSocket("udp4");
  udp.on("message", (message, from) => {
    try {
      udp.send(answer(message, records), from.port, from.address);
    } catch { /* a malformed question gets no answer */ }
  });
  udp.bind(DNS_PORT, "127.0.0.1");
  const control = net.createServer((socket) => {
    let data = "";
    socket.on("data", (chunk) => (data += chunk));
    socket.on("end", () => {
      try {
        const { name, values } = JSON.parse(data) as { name: string; values: string[] };
        if (values.length) records.set(name.toLowerCase(), values);
        else records.delete(name.toLowerCase());
        socket.end("ok");
      } catch {
        socket.end("bad");
      }
    });
  });
  control.listen(CONTROL_PORT, "127.0.0.1");
  return { close: () => { udp.close(); control.close(); } };
}

/** Sets a name's TXT values, or removes it with none. */
export const setTxt = (name: string, values: string[]) => new Promise<void>((resolve, reject) => {
  const socket = net.connect(CONTROL_PORT, "127.0.0.1", () => socket.end(JSON.stringify({ name, values })));
  socket.on("data", () => resolve());
  socket.on("error", reject);
});
