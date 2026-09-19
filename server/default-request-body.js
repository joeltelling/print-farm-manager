// Makes sure req.body is always an object by the time a route handler runs.
//
// Express 4's express.json() leaves req.body as {} when a request has no JSON body (no
// Content-Type, or an empty body). Express 5 leaves it undefined instead. Most route
// handlers in this app destructure it directly (`const { ids } = req.body`), so under
// Express 5 a bare POST or PUT would throw a TypeError and answer 500 instead of the
// documented 400 validation error. Mount this right after express.json(); it is a no-op
// on Express 4 and on any request that did carry a JSON body.
//
// Regression coverage: server/tests/default-request-body.test.js.
module.exports = function defaultRequestBody(req, _res, next) {
  if (req.body === undefined) req.body = {};
  next();
};
