'use strict';

// What a MAC address can and cannot tell you.
//
// The second-least-significant bit of the first octet separates a globally
// unique address, burned in by a manufacturer, from a locally administered one
// chosen by the machine itself. Modern phones and laptops pick a locally
// administered address per network, which is the point of the feature.
//
// The distinction matters twice here. A locally administered address names no
// vendor, so reading an OUI off one produces a company that has nothing to do
// with the device -- on the production Hub one such address was shown as
// "CANDY HOUSE, Inc." at one address and "iRobot Corporation" at another, and
// it was a MacBook both times. And it is not evidence of hardware identity,
// so it cannot be used to argue that two observations are the same machine.

/**
 * True when this is a globally unique (OUI-assigned) hardware address.
 * False for locally administered and randomised addresses, broadcast, all
 * zeroes, and anything that is not a MAC.
 */
function isStableMac(mac) {
  if (!mac || !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac)) return false;
  if (mac === 'ff:ff:ff:ff:ff:ff' || mac === '00:00:00:00:00:00') return false;
  const first = parseInt(mac.split(':')[0], 16);
  return (first & 0x02) === 0;
}

module.exports = { isStableMac };
