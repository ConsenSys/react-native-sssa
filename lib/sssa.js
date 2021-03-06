// @author Alexander Stetsyuk
// @license MIT
// @author Glenn Rempe <glenn@rempe.us>
// @license MIT
// @author Hadas Zeilberger <hadas.zeilberger@consensys.net>
// @license Apache2
import { generateCoefficients } from './randomBitGenerator';
import { CharacteristicTwoGaloisField } from './galoisField';
var isBase64 = require('is-base64');
import {
  splitBitsToIntArray,
  base64ToBits,
  padLeft,
  hex2bin,
  bin2hex,
  bitsToBase64,
  convertIntArrayToBits,
  markPadding,
  removePadding
} from './utils.js';
/** Represents an SSSA implementation where coefficients are of length coeffLength
 * and are considered in the field GF(2^coeffLength)
 */
export class SSSA {
  /**
   *
   * @class
   * @param {number} coeffLength - bit length of coefficients in polynomial used to construct shamir shares
   */
  constructor(coeffLength) {
    this.fieldSize = Math.pow(2, coeffLength);
    this.char2GF = new CharacteristicTwoGaloisField(this.fieldSize);
    this.coeffLength = coeffLength;
  }
  /**@param {number} x - the x coordinate at which to evaluate the polynomial
   * @param {Array} coeffs - array of bit sequences, each of which represents a term in the polynomial. The first
   * element in the array is the coefficient of the 0th term
   * @returns {number} - the y coordinate for the given x coordinate on the polynomial represented by coeffs
   */
  horner(x, coeffs) {
    let galoisField = this.char2GF;
    let fx = 0;
    for (let i = coeffs.length - 1; i >= 0; i--) {
      let coefficient = coeffs[i];
      if (fx !== 0) {
        fx = galoisField
          .multiply(x, fx)
          .plus(coefficient)
          .getValue();
      } else {
        fx = coefficient;
      }
    }

    return fx;
  }
  /**@param {Array} coeffs - array of coefficients representing a polynomial where
   * the 0th element in the array represents the 0th term of the polynomial
   * @param {number} numShares - the number of shares to generate for the polynomial represented by coeffs
   * @returns {Array} - an array of points of the polynomial represented by coeffs
   */
  getPointsOnPolynomialFor(coeffs, numShares) {
    let shares = [],
      i,
      len;

    for (i = 1, len = numShares + 1; i < len; i++) {
      shares[i - 1] = this.horner(i, coeffs);
    }
    return shares;
  }
  /**@param {Array} shares - the final shares returned by generateShares
   * @returns {string} - base64 secret that was input to generateShares
   */
  combine(shares) {
    let points = this.publicShareToPoints(shares);
    let secretChunks = this.getChunksFromPoints(points);
    return this.combineSecret(secretChunks);
  }
  /**@param {Array} x - the x-values of the shares that were generated for one secret chunk
   * @param {Array} y - the y-values of the shares that were generated for one secret chunk
   * @returns {number} - the 0th term of the polynomial that was used to generate the shares for one secret chunk
   */
  lagrange(x, y) {
    let sum = 0,
      len,
      product,
      i,
      j,
      galoisField = this.char2GF;

    for (i = 0, len = x.length; i < len; i++) {
      if (y[i]) {
        product = galoisField.logs[y[i]];

        for (j = 0; j < len; j++) {
          if (i !== j) {
            if (x[j] === 0) {
              // happens when computing a share that is in the list of shares used to compute it
              product = -1; // fix for a zero product term, after which the sum should be sum^0 = sum, not sum^1
              break;
            }
            product =
              (product +
                galoisField.logs[0 ^ x[j]] -
                galoisField.logs[x[i] ^ x[j]] +
                this.fieldSize -
                1) %
              (this.fieldSize - 1);
          }
        }

        sum = product === -1 ? sum : sum ^ galoisField.exps[product];
      }
    }

    return sum;
  }
  /**@param {string} secret - base64 encoded secret
   * @param {number} padLength - the number of 0's to pad the secret with, to hide the length
   * @returns {Array} - an array of integers generated by starting from the end of the bit sequence, and creating the next int from the
   * previous this.coeffLength number of bits
   */
  splitSecret(secret, padLength) {
    let secretInBits = markPadding(base64ToBits(secret));
    let secretChunks = splitBitsToIntArray(
      secretInBits,
      this.coeffLength,
      padLength
    );
    return secretChunks;
  }
  /**@param {Array} secretChunks - array of integers, where each element is a chunk of the secret as outputed by splitSecret
   * @returns {string} - base64 secret
   */
  combineSecret(secretChunks) {
    let result = convertIntArrayToBits(secretChunks, this.coeffLength);
    result = result.slice(result.indexOf('1') + 1);
    return bitsToBase64(result);
  }
  /**@param {Array} secretChunks - an array of integers, each of which is a chunk of the secret
   * @param {number} numShares - the number of shares to generate for each chunk
   * @param {number} threshold - the minimum number of points needed to re-generate each secret chunk
   * @returns {Array} - a 2d array of points where element i is the array of y values for secret i
   */
  async getPointsFromChunks(secretChunks, numShares, threshold) {
    let allPoints = [];
    for (let i = 0; i < secretChunks.length; i++) {
      let secretChunk = secretChunks[i];
      let polynomial = await generateCoefficients(
        secretChunk,
        threshold,
        this.coeffLength
      );
      let subShares = this.getPointsOnPolynomialFor(
        polynomial,
        numShares,
        threshold
      );

      allPoints[i] = subShares;
    }
    return allPoints;
  }
  /**@param {Array} points - a 2-d array of points, where the i,jth term is the y-coordinate of point j of the ith secret chunk
   * @returns {Array} - an array of integers, each of which is a chunk of the secret
   */
  getChunksFromPoints(points) {
    let x = [...Array(points[0].length).keys()].map(x => x + 1);
    let secretChunks = [];
    for (var i = 0; i < points.length; i++) {
      secretChunks[i] = this.lagrange(x, points[i]);
    }
    return secretChunks;
  }
  /**@param {Array} allPoints - a 2-d array representing the y-coordinates of the points for each secret chunk. the [i][j]th element is y-coordinate j for secret chunk i
     *@returns {Array} - a 2-d array, which in linear algebra terms is the transpose of the input matrix. In plain english, it is a 2-d array
     whose [j][i] term is equal to the [i][j] term of the input
     */
  createCrossSection(allPoints) {
    let y = [];
    let numSecretChunks = allPoints.length;
    for (let i = 0; i < numSecretChunks; i++) {
      let subShares = allPoints[i];
      for (let j = 0; j < subShares.length; j++) {
        y[j] = y[j] || [];
        y[j].push(subShares[j]);
      }
    }
    return y;
  }
  /**@param {Array} crossSection - a 2-d array, where the [i][j]th term represents the ith y-coordinate of the jth secret
   * It should be the output from createCrossSection
   * @returns {Array} - a 1-d array, where element i is the concatenation of binary forms for the ith term of each secret chunk
   */
  sharesToBin(crossSection) {
    if (!crossSection.length && !crossSection[0].length) {
      throw new Error(
        'input to sharesToBin is expected to be a 2-d arary, representing shamir shares'
      );
    }
    let output = [];
    let shares = crossSection;
    for (var i = 0; i < shares.length; i++) {
      for (var j = 0; j < shares[i].length; j++) {
        output[i] =
          padLeft(shares[i][j].toString(2), this.coeffLength) +
          (output[i] || '');
      }
    }
    return output;
  }
  /**@param {Array} shares - element i is a concatenation of the ith y-coordiantes of all the secret chunks
   * @returns {Array} - element i is element i of the input in hex, prepended with the associated x-coordinate in hex
   */
  binarySharesToPublicShareString(shares) {
    let x = [];
    for (let i = 0; i < shares.length; i++) {
      x[i] = this.constructPublicShareString(
        i + 1,
        bin2hex(markPadding(shares[i]))
      ); //changed to hex so it can be used with RegEx
    }
    return x;
  }
  /**@param {Array}  shares - an array of shares. Element i is the concatenation of the ith shares of all secret chunks, in hex
   * @returns {Array} - a 2-d array of points where term i is the array of points for secretChunk i
   */
  publicShareToPoints(shares) {
    let x = [],
      y = [];
    for (let i = 0; i < shares.length; i++) {
      let share = this.deconstructPublicShareString(shares[i]);
      if (x.indexOf(share.id) === -1) {
        x.push(share.id);
        let binData = removePadding(hex2bin(share.data));
        let splitShare = splitBitsToIntArray(binData, this.coeffLength);
        for (let j = 0; j < splitShare.length; j++) {
          y[j] = y[j] || [];
          y[j][x.length - 1] = splitShare[j];
        }
      }
    }
    return y;
  }
  /**@param {string} secret - the secret to generate shares from
   * @param {number} numShares - the number of shares to generate
   * @param {number} threshold - the minimum number of  shares needed to reconstruct the secret
   * @param {number} padLength - the number of 0's to pad the secret with, to hide the length of the original secret
   * @returns {Array} -  an array of shares, all of which are needed to reconstruct the secret
   */
  async generateShares(secret, numShares, threshold, padLength) {
    padLength = padLength || 128;
    this.verifyInput(secret, numShares, threshold, padLength);
    let secretChunks = this.splitSecret(secret, padLength);
    let pointsFromChunks = await this.getPointsFromChunks(
      secretChunks,
      numShares,
      threshold
    );
    let crossSection = this.createCrossSection(pointsFromChunks);
    let shares = this.sharesToBin(crossSection);
    return this.binarySharesToPublicShareString(shares);
  }
  /**@param {number} id - the x-coordinate that the param data is associated with
   * @param {string} data - a hex string representing a share which is one y-coordinate from each secret chunk, concatenated together
   * @returns {string} - the y-coordinates with the associated x-coordinate prepended to it, converted to hex
   */
  constructPublicShareString(id, data) {
    var idHex, idMax, idPaddingLen, newShareString;

    idMax = this.fieldSize - 1;
    idPaddingLen = idMax.toString(16).length;
    idHex = padLeft(id.toString(16), idPaddingLen);

    if (typeof id !== 'number' || id % 1 !== 0 || id < 1 || id > idMax) {
      throw new Error(
        'Share id must be an integer between 1 and ' + idMax + ', inclusive.'
      );
    }

    newShareString = idHex + data;

    return newShareString;
  }
  /**@param {string} share - one share in final form
   * @returns {Object} - the share, parsed apart into data and associated x-coordinate
   */
  deconstructPublicShareString(share) {
    let id,
      idLen,
      max,
      obj = {},
      regexStr,
      shareComponents;

    max = this.fieldSize - 1;

    // Determine the ID length which is variable and based on the bit count.
    idLen = max.toString(16).length;

    // Extract all the parts now that the segment sizes are known.
    regexStr = '^([a-fA-F0-9]{' + idLen + '})([a-fA-F0-9]+)$';
    shareComponents = new RegExp(regexStr).exec(share); //first element of output array is entire share, second element is the first part, up to idLen chars, and the third element is the second component (ie the data)

    // The ID is a Hex number and needs to be converted to an Integer
    if (shareComponents) {
      id = parseInt(shareComponents[1]);
    }

    if (typeof id !== 'number' || id % 1 !== 0 || id < 1 || id > max) {
      throw new Error(
        'Invalid share : Share id must be an integer between 1 and ' +
          max +
          ', inclusive.' +
          id
      );
    }

    if (shareComponents && shareComponents[2]) {
      obj.id = id;
      obj.data = shareComponents[2];
      return obj;
    }

    throw new Error('The share data provided is invalid : ' + share);
  }
  /**@param {string} secret - the original base64 secret
   * @param {number} numShares - the number of points to generate for each secret chunk
   * @param {number} threshold - the minimum number of points needed to re-generate the entire secret
   * @param {number} padLength - the amount of 0's to pad the secret with, to hide its length
   * the purpose of this function is to verify the input, and throw and error if anything is wrong
   */
  verifyInput(secret, numShares, threshold, padLength) {
    if (typeof secret !== 'string') {
      throw new Error('Secret must be a string.');
    }
    if (typeof numShares !== 'number' || numShares % 1 !== 0 || numShares < 2) {
      throw new Error(
        'Number of shares must be an integer between 2 and  (' +
          this.fieldSize -
          1 +
          '), inclusive.'
      );
    }
    if (numShares > this.fieldSize - 1) {
      let neededBits = Math.ceil(Math.log(numShares + 1) / Math.LN2);
      throw new Error(
        'Number of shares must be an integer between 2 and (' +
          this.fieldSize -
          1 +
          '), inclusive. To create ' +
          numShares +
          ' shares, use at least ' +
          neededBits +
          ' bits.'
      );
    }
    if (typeof threshold !== 'number' || threshold % 1 !== 0 || threshold < 2) {
      throw new Error(
        'Threshold number of shares must be an integer between 2 and 2^bits-1 (' +
          this.fieldSize -
          1 +
          '), inclusive.'
      );
    }
    if (threshold > numShares) {
      throw new Error(
        'Threshold number of shares was ' +
          threshold +
          ' but must be less than or equal to the ' +
          numShares +
          ' shares specified as the total to generate.'
      );
    }
    if (
      typeof padLength !== 'number' ||
      padLength % 1 !== 0 ||
      padLength < 0 ||
      padLength > 1024
    ) {
      throw new Error(
        'Zero-pad length must be an integer between 0 and 1024 inclusive.'
      );
    }
    if (!isBase64(secret)) {
      throw new Error('secret but be base-64');
    }
  }
}
