// # iFLUX Client
// Helps to make iFLUX communications in NodeJS apps.
var ioc = require('./lib/ioc');

module.exports = {
  Runner: ioc.create('runner'),
  version: require('./package').version
};
