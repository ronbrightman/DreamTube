// test/helpers/fake-event.js
//
// Builds a minimal Netlify Functions (AWS Lambda-compatible) event object
// — just enough shape for the handlers under test (httpMethod, headers,
// body, queryStringParameters). `ip` fills in the x-nf-client-connection-ip
// header rate-limit.js's clientIp() reads first, so tests can give each
// scenario its own rate-limit bucket instead of sharing one.

function fakeEvent(opts) {
  opts = opts || {};
  var headers = Object.assign({}, opts.headers || {});
  if (opts.ip) headers['x-nf-client-connection-ip'] = opts.ip;
  return {
    httpMethod: opts.method || 'GET',
    headers: headers,
    queryStringParameters: opts.query || null,
    body: opts.body !== undefined ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : null,
    isBase64Encoded: false
  };
}

module.exports = { fakeEvent: fakeEvent };
