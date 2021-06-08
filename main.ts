import { Application, Router, isHttpError, Status } from "https://deno.land/x/oak@v7.5.0/mod.ts";
import SsbHost from './SsbHost.ts'
import udpPeerDiscoverer from './udpPeerDiscoverer.ts'
import connectionPage from './connectionPage.ts'

const host = new SsbHost()



const router = new Router();
router
  .get("/", (ctx) => {
    let responseBody = ''
    responseBody += `<h1>SBB Connection Tool</h1>
    <p>This Host: ${host.id}</p>
    `
    log(JSON.stringify(peerAddresses))
    for (const [host, addresses] of peerAddresses) {
      responseBody += `<li>${host}
        <ul>
          ${addresses.map(v => `<li>${v}<a href="/shake-hands/${v.replaceAll('/', '_')}">shake hands</a></li>`)}
        </ul>  
      </li>`
    }
    ctx.response.type = 'html'
    ctx.response.body = responseBody
  })
  .get("/shake-hands/:addressParam", async (ctx) => {
    ctx.response.type = 'html'
    if (!ctx.params.addressParam) {
      ctx.response.status = 400
    } else {
      const addressString = ctx.params.addressParam.replaceAll('_', '/')
      await connectionPage(addressString, host, ctx.response)
    }
  });

const app = new Application();

// Logger
app.use(async (ctx, next) => {
  await next();
  const rt = ctx.response.headers.get("X-Response-Time");
  console.log(`${ctx.request.method} ${ctx.request.url} - ${rt}`);
});

// Timing
app.use(async (ctx, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  ctx.response.headers.set("X-Response-Time", `${ms}ms`);
});

app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    ctx.response.body = err.toString()
    if (isHttpError(err)) {
      ctx.response.status = err.status
    } else {
      ctx.response.status = Status.InternalServerError
    }
  }
});

const logMessages: string[] = []

function log(...msg: {toString: () => string}[]) {
  logMessages.push(msg.map(o => o.toString()).join(', '))
}

app.use(router.routes());
app.use(router.allowedMethods());

app.listen({ port: 8000 });

const peerAddresses: Map<string, string[]> = new Map()

for await (const peer of udpPeerDiscoverer) {
  peerAddresses.set(peer.hostname, peer.addresses)
}
