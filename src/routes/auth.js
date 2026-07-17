'use strict';

const { Router } = require('express');
const authSessionRoutes = require('./auth-sessions');
const routerSetupRoutes = require('./router-setup');

module.exports = function authRoutes(ctx) {
  const router = Router();
  router.use(authSessionRoutes(ctx));
  router.use(routerSetupRoutes(ctx));
  return router;
};
