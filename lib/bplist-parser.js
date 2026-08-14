/**
 * bplist-parser.js
 * Self-contained, dependency-free Apple Binary Property List (bplist00) parser.
 *
 * Runs inside a Chrome Extension (Manifest V3) with no Node `Buffer` dependency.
 * Operates on a DataView over an ArrayBuffer.
 *
 * Supports object types used by Safari's Bookmarks.plist:
 *   null, false, true, int, real, date, data, ascii/utf-16 string,
 *   uid, array, set (as array), dict.
 */
(function (global) {
  'use strict';

  const TAGS = {
    NULL: 0x00, FALSE: 0x08, TRUE: 0x09, FILL: 0x0F,
    INT: 0x10, REAL: 0x20, DATE: 0x30, DATA: 0x40,
    ASCII_STRING: 0x50, UNICODE_STRING: 0x60, UID: 0x80,
    ARRAY: 0xA0, SET: 0xC0, DICT: 0xD0,
  };

  function readUInt64BE(view, offset) {
    const hi = view.getUint32(offset);
    const lo = view.getUint32(offset + 4);
    return hi * 0x100000000 + lo;
  }

  function readSInt64BE(view, offset) {
    // hi is read as a signed 32-bit int, so the combined value is already
    // correct for negative 64-bit ints (two's complement).
    const hi = view.getInt32(offset);
    const lo = view.getUint32(offset + 4);
    return hi * 0x100000000 + lo;
  }

  function readIntOfSize(view, offset, size) {
    switch (size) {
      case 1: return view.getUint8(offset);
      case 2: return view.getUint16(offset);
      case 4: return view.getUint32(offset);
      case 8: return readUInt64BE(view, offset);
      default: throw new Error('Unsupported int size: ' + size);
    }
  }

  /**
   * Parse a binary plist from an ArrayBuffer / Uint8Array.
   * Returns the root object (usually an object/array).
   *
   * Throws a descriptive error if the bytes are not a binary plist, including
   * a hint when the input looks like an XML plist (which Safari can produce
   * when exported via File > Export Bookmarks, or fetched from iCloud).
   */
  function parseBuffer(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const isBplist =
      bytes.length >= 8 &&
      bytes[0] === 0x62 && bytes[1] === 0x70 && bytes[2] === 0x6C &&
      bytes[3] === 0x69 && bytes[4] === 0x73 && bytes[5] === 0x74 &&
      bytes[6] === 0x30 && bytes[7] === 0x30;
    if (!isBplist) {
      // Sniff for XML plist so we can give a useful error message.
      const head = [];
      for (let i = 0; i < Math.min(bytes.length, 256); i++) head.push(bytes[i]);
      const headStr = String.fromCharCode.apply(null, head);
      let hint = '';
      if (/^\s*<\?xml/.test(headStr)) {
        if (/<plist[\s>]/.test(headStr)) {
          hint = ' The file looks like an XML plist (<?xml ... <plist>...). ' +
                 'Only the Safari binary plist at ~/Library/Safari/Bookmarks.plist is supported.';
        } else {
          hint = ' The file looks like XML but not a plist.';
        }
      } else if (headStr.trim() === '') {
        hint = ' The file appears to be empty or unreadable.';
      } else {
        hint = ' First bytes: 0x' + Array.from(bytes.slice(0, 8))
          .map((b) => b.toString(16).padStart(2, '0')).join(' ');
      }
      throw new Error('Not a binary plist (missing bplist00 header).' + hint);
    }
    if (bytes.length < 40) throw new Error('Truncated bplist (no trailer)');

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tOff = bytes.length - 32;
    const offsetIntSize = view.getUint8(tOff + 6);
    const objectRefSize = view.getUint8(tOff + 7);
    const numObjects = Number(readUInt64BE(view, tOff + 8));
    const topObject = Number(readUInt64BE(view, tOff + 16));
    const offsetTableOffset = readUInt64BE(view, tOff + 24);

    const offsets = new Array(numObjects);
    for (let i = 0; i < numObjects; i++) {
      offsets[i] = readIntOfSize(view, offsetTableOffset + i * offsetIntSize, offsetIntSize);
    }

    const cache = new Array(numObjects);
    const stack = new Set();

    // [count, extraBytes] for a tag's low nibble.
    // When low == 0x0F, the next byte encodes the count size: its low nibble N
    // means the count is stored in 2^N following bytes.
    function readCount(offset, low) {
      if (low !== 0x0F) return [low, 0];
      const sizeByte = view.getUint8(offset + 1);
      const size = 1 << (sizeByte & 0x0F);
      return [readIntOfSize(view, offset + 2, size), 1 + size];
    }

    function parseObject(ref) {
      if (ref < 0 || ref >= numObjects) throw new Error('Object ref out of range: ' + ref);
      if (cache[ref] !== undefined) return cache[ref];
      if (stack.has(ref)) return null; // cycle guard
      stack.add(ref);

      const offset = offsets[ref];
      const header = view.getUint8(offset);
      const tag = header & 0xF0;
      const low = header & 0x0F;
      let result;

      switch (tag) {
        case TAGS.NULL: case TAGS.FILL: result = null; break;
        case TAGS.FALSE: result = false; break;
        case TAGS.TRUE: result = true; break;
        case TAGS.INT: {
          const size = 1 << low;
          result = size <= 4
            ? readIntOfSize(view, offset + 1, size)
            : readSInt64BE(view, offset + 1);
          break;
        }
        case TAGS.REAL: {
          const size = 1 << low;
          result = size === 4
            ? view.getFloat32(offset + 1)
            : view.getFloat64(offset + 1);
          break;
        }
        case TAGS.DATE:
          result = new Date(view.getFloat64(offset + 1) * 1000 + 978307200000);
          break;
        case TAGS.DATA: {
          const [len, extra] = readCount(offset, low);
          const start = offset + 1 + extra;
          result = new Uint8Array(bytes.subarray(start, start + len));
          break;
        }
        case TAGS.ASCII_STRING: {
          const [len, extra] = readCount(offset, low);
          const start = offset + 1 + extra;
          let s = '';
          for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[start + i]);
          result = s;
          break;
        }
        case TAGS.UNICODE_STRING: {
          const [len, extra] = readCount(offset, low);
          const start = offset + 1 + extra;
          result = new TextDecoder('utf-16be').decode(bytes.subarray(start, start + len * 2));
          break;
        }
        case TAGS.UID:
          result = readIntOfSize(view, offset + 1, low + 1);
          break;
        case TAGS.ARRAY:
        case TAGS.SET: {
          const [len, extra] = readCount(offset, low);
          const arr = new Array(len);
          for (let i = 0; i < len; i++) {
            const childRef = readIntOfSize(view, offset + 1 + extra + i * objectRefSize, objectRefSize);
            arr[i] = parseObject(childRef);
          }
          result = arr;
          break;
        }
        case TAGS.DICT: {
          const [len, extra] = readCount(offset, low);
          const obj = {};
          for (let i = 0; i < len; i++) {
            const keyRef = readIntOfSize(view, offset + 1 + extra + i * objectRefSize, objectRefSize);
            const valRef = readIntOfSize(view, offset + 1 + extra + (len + i) * objectRefSize, objectRefSize);
            const key = parseObject(keyRef);
            obj[key] = parseObject(valRef);
          }
          result = obj;
          break;
        }
        default:
          throw new Error('Unknown bplist tag 0x' + tag.toString(16) + ' at offset ' + offset);
      }

      stack.delete(ref);
      cache[ref] = result;
      return result;
    }

    return parseObject(topObject);
  }

  const BplistParser = { parse: parseBuffer, parseBuffer: parseBuffer, VERSION: 'v2-2026-08-04' };

  if (typeof module !== 'undefined' && module.exports) module.exports = BplistParser;
  if (typeof globalThis !== 'undefined') globalThis.BplistParser = BplistParser;
})(typeof globalThis !== 'undefined' ? globalThis : this);

