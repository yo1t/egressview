'use strict';

const { Router } = require('express');
const authSessionRoutes = require('./auth-sessions');
const authSecurityRoutes = require('./auth-security');
const routerSetupRoutes = require('./router-setup');

module.exports = function authRoutes(ctx) {
  const router = Router();
  router.use(authSessionRoutes(ctx));
  router.use(authSecurityRoutes(ctx));
  router.use(routerSetupRoutes(ctx));
  return router;
};
