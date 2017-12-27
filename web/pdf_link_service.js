/* Copyright 2015 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { getGlobalEventBus } from './dom_events';
import { parseQueryString } from './ui_utils';

/**
 * @typedef {Object} PDFLinkServiceOptions
 * @property {EventBus} eventBus - The application event bus.
 */

/**
 * Performs navigation functions inside PDF, such as opening specified page,
 * or destination.
 * @implements {IPDFLinkService}
 */
class PDFLinkService {
  /**
   * @param {PDFLinkServiceOptions} options
   */
  constructor({ eventBus, } = {}) {
    this.eventBus = eventBus || getGlobalEventBus();
    this.baseUrl = null;
    this.pdfDocument = null;
    this.pdfViewer = null;
    this.pdfHistory = null;

    this._pagesRefCache = null;
  }

  setDocument(pdfDocument, baseUrl) {
    this.baseUrl = baseUrl;
    this.pdfDocument = pdfDocument;
    this._pagesRefCache = Object.create(null);
  }

  setViewer(pdfViewer) {
    this.pdfViewer = pdfViewer;
  }

  setHistory(pdfHistory) {
    this.pdfHistory = pdfHistory;
  }

  /**
   * @returns {number}
   */
  get pagesCount() {
    return this.pdfDocument ? this.pdfDocument.numPages : 0;
  }

  /**
   * @returns {number}
   */
  get page() {
    return this.pdfViewer.currentPageNumber;
  }

  /**
   * @param {number} value
   */
  set page(value) {
    this.pdfViewer.currentPageNumber = value;
  }

  /**
   * @returns {number}
   */
  get rotation() {
    return this.pdfViewer.pagesRotation;
  }

  /**
   * @param {number} value
   */
  set rotation(value) {
    this.pdfViewer.pagesRotation = value;
  }

  /**
   * @param {string|Array} dest - The named, or explicit, PDF destination.
   */
  navigateTo(dest) {
    let goToDestination = ({ namedDest, explicitDest, }) => {
      // Dest array looks like that: <page-ref> </XYZ|/FitXXX> <args..>
      let destRef = explicitDest[0], pageNumber;

      if (destRef instanceof Object) {
        pageNumber = this._cachedPageNumber(destRef);

        if (pageNumber === null) {
          // Fetch the page reference if it's not yet available. This could
          // only occur during loading, before all pages have been resolved.
          this.pdfDocument.getPageIndex(destRef).then((pageIndex) => {
            this.cachePageRef(pageIndex + 1, destRef);
            goToDestination({ namedDest, explicitDest, });
          }).catch(() => {
            console.error(`PDFLinkService.navigateTo: "${destRef}" is not ` +
                          `a valid page reference, for dest="${dest}".`);
          });
          return;
        }
      } else if (Number.isInteger(destRef)) {
        pageNumber = destRef + 1;
      } else {
        console.error(`PDFLinkService.navigateTo: "${destRef}" is not ` +
                      `a valid destination reference, for dest="${dest}".`);
        return;
      }
      if (!pageNumber || pageNumber < 1 || pageNumber > this.pagesCount) {
        console.error(`PDFLinkService.navigateTo: "${pageNumber}" is not ` +
                      `a valid page number, for dest="${dest}".`);
        return;
      }

      let scrollToDest = () => {
        if (this.pdfHistory) {
          // Update the browser history before scrolling the new destination
          // into view, so to accurately capture the current document position.
          this.pdfHistory.pushCurrentPosition();
          this.pdfHistory.push({ namedDest, explicitDest, pageNumber, });
        }

        this.pdfViewer.scrollPageIntoView({
          pageNumber,
          destArray: explicitDest,
        });
      };

      if (!namedDest.startsWith('cite')) {
        scrollToDest();
        return;
      }

      let sortNumeric = (a, b) => {
        return a - b;
      };
      let getUnique = (uniq, itm) => {
        if (uniq.length === 0 || (itm - uniq[uniq.length - 1]) > 0.01) {
          uniq.push(itm);
        }
        return uniq;
      };

      let pdfPage = this.pdfDocument.getPage(pageNumber);

      pdfPage.then((page) => {
        return page.getTextContent();
      }).then((textContent) => {
        let lineHeight = Object.values(
          textContent.items.reduce((byXs, text) => {
            let textX = text.transform[4].toFixed(3);
            let byX = byXs[textX] || [];
            byX.push(text);
            byXs[textX] = byX;
            return byXs;
          }, {}))
          .filter((texts) => {
            return texts.length > 1;
          })
          .map((texts) => {
            return texts
              .map((text) => {
                return parseFloat(text.transform[5].toFixed(3)); // ys
              })
              .sort(sortNumeric).reduce(getUnique, [])
              .reduce((deltas, y, i, arr) => {
                let delta = y - arr[i - 1];
                deltas = Array.isArray(deltas) ? deltas : [];
                deltas.push(delta);
                return deltas;
              })
              .sort(sortNumeric).reduce(getUnique, []);
          })
          .reduce((flat, deltas) => {
            return flat.concat(deltas);
          })
          .sort(sortNumeric).reduce(getUnique, [])[0];

        let refX = explicitDest[2], refY = explicitDest[3];
        // /\[\d+\]\s*/
        let nearestText = textContent.items.reduce((nearestText, text) => {
          // find what is likely the author
          // if (!/^[a-z]/i.test(text.str)) {
          //   return nearestText;
          // }
          let textX = text.transform[4], textY = text.transform[5];
          let dist = Math.abs(refX - textX) + Math.abs(refY - textY);
          if (textY <= refY && dist < nearestText[0]) {
            return [dist, text];
          }
          return nearestText;
        }, [Number.MAX_VALUE, undefined]).pop();

        pdfPage.then((page) => {
          let viewportWidth = page.getViewport().viewBox[2];
          let nearestPar = textContent.items
            .filter((text) => {
              let deltaX = text.transform[4] - nearestText.transform[4];
              return (text.transform[5] <= nearestText.transform[5] &&
                Math.abs(deltaX) < (viewportWidth / 4) &&
                text !== nearestText);
            })
            .sort((t1, t2) => { // by y
              let dY = t2.transform[5] - t1.transform[5];
              let dX = t1.transform[4] - t2.transform[4];
              return Math.abs(dY) > 1e-2 ? dY : dX;
            })
            .reduce((parTexts, text) => {
              let lastY = parTexts[parTexts.length - 1].transform[5];
              if (lastY - text.transform[5] < 1.05 * lineHeight &&
                !/^\s*\[\d+\]/.test(text.str) && parTexts.length <= 5) {
                parTexts.push(text);
              }
              return parTexts;
            }, [nearestText])
            .map((text) => {
              return text.str;
            })
            .join(' ').trim()
            .replace(/\s+/ig, ' ')
            .replace(/(- | [.,])/ig, '')
            .replace(/\[\d+\]\s+/ig, '');

          let req = new XMLHttpRequest();
          let queryUrl = 'https://duckduckgo.com/html?q=' +
            encodeURIComponent(nearestPar);
          req.open('GET', queryUrl);
          req.onload = function() {
            if (this.status < 200 || this.status >= 300) {
              scrollToDest();
            }

            let serp = document.createElement('template');
            serp.innerHTML = req.responseText;
            let results = serp.content.querySelectorAll('.result__a'),
              links = Array.prototype.map.call(results, (a) => {
                return a.href;
              });

            let paperLink;
            for (let i = 0; i < links.length; i++) {
              let link = links[i];
              if (/arxiv\.org/.test(link)) {
                paperLink = link.replace('/pdf/', '/abs/');
              } else if (/nips\.cc/.test(link)) {
                paperLink = link.replace('.pdf', '');
              } else if (/jmlr\.csail/.test(link)) {
                paperLink = link;
              }

              if (paperLink) {
                break;
              }
            }

            // eslint-disable-next-line no-undef
            chrome.tabs.getCurrent((tab) => {
              // eslint-disable-next-line no-undef
              chrome.tabs.create({
                url: paperLink || queryUrl.replace('/html', ''),
                index: tab.index + 1,
                active: false,
                openerTabId: tab.id,
              });
            });
          };
          req.onerror = scrollToDest;
          req.send();
        });
      });
    };

    new Promise((resolve, reject) => {
      if (typeof dest === 'string') {
        this.pdfDocument.getDestination(dest).then((destArray) => {
          resolve({
            namedDest: dest,
            explicitDest: destArray,
          });
        });
        return;
      }
      resolve({
        namedDest: '',
        explicitDest: dest,
      });
    }).then((data) => {
      if (!(data.explicitDest instanceof Array)) {
        console.error(`PDFLinkService.navigateTo: "${data.explicitDest}" is` +
                      ` not a valid destination array, for dest="${dest}".`);
        return;
      }
      goToDestination(data);
    });
  }

  /**
   * @param {string|Array} dest - The PDF destination object.
   * @returns {string} The hyperlink to the PDF object.
   */
  getDestinationHash(dest) {
    if (typeof dest === 'string') {
      return this.getAnchorUrl('#' + escape(dest));
    }
    if (dest instanceof Array) {
      let str = JSON.stringify(dest);
      return this.getAnchorUrl('#' + escape(str));
    }
    return this.getAnchorUrl('');
  }

  /**
   * Prefix the full url on anchor links to make sure that links are resolved
   * relative to the current URL instead of the one defined in <base href>.
   * @param {String} anchor The anchor hash, including the #.
   * @returns {string} The hyperlink to the PDF object.
   */
  getAnchorUrl(anchor) {
    return (this.baseUrl || '') + anchor;
  }

  /**
   * @param {string} hash
   */
  setHash(hash) {
    let pageNumber, dest;
    if (hash.indexOf('=') >= 0) {
      let params = parseQueryString(hash);
      if ('search' in params) {
        this.eventBus.dispatch('findfromurlhash', {
          source: this,
          query: params['search'].replace(/"/g, ''),
          phraseSearch: (params['phrase'] === 'true'),
        });
      }
      // borrowing syntax from "Parameters for Opening PDF Files"
      if ('nameddest' in params) {
        this.navigateTo(params.nameddest);
        return;
      }
      if ('page' in params) {
        pageNumber = (params.page | 0) || 1;
      }
      if ('zoom' in params) {
        // Build the destination array.
        let zoomArgs = params.zoom.split(','); // scale,left,top
        let zoomArg = zoomArgs[0];
        let zoomArgNumber = parseFloat(zoomArg);

        if (zoomArg.indexOf('Fit') === -1) {
          // If the zoomArg is a number, it has to get divided by 100. If it's
          // a string, it should stay as it is.
          dest = [null, { name: 'XYZ', },
                  zoomArgs.length > 1 ? (zoomArgs[1] | 0) : null,
                  zoomArgs.length > 2 ? (zoomArgs[2] | 0) : null,
                  (zoomArgNumber ? zoomArgNumber / 100 : zoomArg)];
        } else {
          if (zoomArg === 'Fit' || zoomArg === 'FitB') {
            dest = [null, { name: zoomArg, }];
          } else if ((zoomArg === 'FitH' || zoomArg === 'FitBH') ||
                     (zoomArg === 'FitV' || zoomArg === 'FitBV')) {
            dest = [null, { name: zoomArg, },
                    zoomArgs.length > 1 ? (zoomArgs[1] | 0) : null];
          } else if (zoomArg === 'FitR') {
            if (zoomArgs.length !== 5) {
              console.error(
                'PDFLinkService.setHash: Not enough parameters for "FitR".');
            } else {
              dest = [null, { name: zoomArg, },
                      (zoomArgs[1] | 0), (zoomArgs[2] | 0),
                      (zoomArgs[3] | 0), (zoomArgs[4] | 0)];
            }
          } else {
            console.error(`PDFLinkService.setHash: "${zoomArg}" is not ` +
                          'a valid zoom value.');
          }
        }
      }
      if (dest) {
        this.pdfViewer.scrollPageIntoView({
          pageNumber: pageNumber || this.page,
          destArray: dest,
          allowNegativeOffset: true,
        });
      } else if (pageNumber) {
        this.page = pageNumber; // simple page
      }
      if ('pagemode' in params) {
        this.eventBus.dispatch('pagemode', {
          source: this,
          mode: params.pagemode,
        });
      }
    } else { // Named (or explicit) destination.
      dest = unescape(hash);
      try {
        dest = JSON.parse(dest);

        if (!(dest instanceof Array)) {
          // Avoid incorrectly rejecting a valid named destination, such as
          // e.g. "4.3" or "true", because `JSON.parse` converted its type.
          dest = dest.toString();
        }
      } catch (ex) {}

      if (typeof dest === 'string' || isValidExplicitDestination(dest)) {
        this.navigateTo(dest);
        return;
      }
      console.error(`PDFLinkService.setHash: "${unescape(hash)}" is not ` +
                    'a valid destination.');
    }
  }

  /**
   * @param {string} action
   */
  executeNamedAction(action) {
    // See PDF reference, table 8.45 - Named action
    switch (action) {
      case 'GoBack':
        if (this.pdfHistory) {
          this.pdfHistory.back();
        }
        break;

      case 'GoForward':
        if (this.pdfHistory) {
          this.pdfHistory.forward();
        }
        break;

      case 'NextPage':
        if (this.page < this.pagesCount) {
          this.page++;
        }
        break;

      case 'PrevPage':
        if (this.page > 1) {
          this.page--;
        }
        break;

      case 'LastPage':
        this.page = this.pagesCount;
        break;

      case 'FirstPage':
        this.page = 1;
        break;

      default:
        break; // No action according to spec
    }

    this.eventBus.dispatch('namedaction', {
      source: this,
      action,
    });
  }

  /**
   * @param {Object} params
   */
  onFileAttachmentAnnotation({ id, filename, content, }) {
    this.eventBus.dispatch('fileattachmentannotation', {
      source: this,
      id,
      filename,
      content,
    });
  }

  /**
   * @param {number} pageNum - page number.
   * @param {Object} pageRef - reference to the page.
   */
  cachePageRef(pageNum, pageRef) {
    let refStr = pageRef.num + ' ' + pageRef.gen + ' R';
    this._pagesRefCache[refStr] = pageNum;
  }

  _cachedPageNumber(pageRef) {
    let refStr = pageRef.num + ' ' + pageRef.gen + ' R';
    return (this._pagesRefCache && this._pagesRefCache[refStr]) || null;
  }
}

function isValidExplicitDestination(dest) {
  if (!(dest instanceof Array)) {
    return false;
  }
  let destLength = dest.length, allowNull = true;
  if (destLength < 2) {
    return false;
  }
  let page = dest[0];
  if (!(typeof page === 'object' &&
        Number.isInteger(page.num) && Number.isInteger(page.gen)) &&
      !(Number.isInteger(page) && page >= 0)) {
    return false;
  }
  let zoom = dest[1];
  if (!(typeof zoom === 'object' && typeof zoom.name === 'string')) {
    return false;
  }
  switch (zoom.name) {
    case 'XYZ':
      if (destLength !== 5) {
        return false;
      }
      break;
    case 'Fit':
    case 'FitB':
      return destLength === 2;
    case 'FitH':
    case 'FitBH':
    case 'FitV':
    case 'FitBV':
      if (destLength !== 3) {
        return false;
      }
      break;
    case 'FitR':
      if (destLength !== 6) {
        return false;
      }
      allowNull = false;
      break;
    default:
      return false;
  }
  for (let i = 2; i < destLength; i++) {
    let param = dest[i];
    if (!(typeof param === 'number' || (allowNull && param === null))) {
      return false;
    }
  }
  return true;
}

class SimpleLinkService {
  /**
   * @returns {number}
   */
  get page() {
    return 0;
  }

  /**
   * @param {number} value
   */
  set page(value) {}

  /**
   * @returns {number}
   */
  get rotation() {
    return 0;
  }

  /**
   * @param {number} value
   */
  set rotation(value) {}

  /**
   * @param dest - The PDF destination object.
   */
  navigateTo(dest) {}

  /**
   * @param dest - The PDF destination object.
   * @returns {string} The hyperlink to the PDF object.
   */
  getDestinationHash(dest) {
    return '#';
  }

  /**
   * @param hash - The PDF parameters/hash.
   * @returns {string} The hyperlink to the PDF object.
   */
  getAnchorUrl(hash) {
    return '#';
  }

  /**
   * @param {string} hash
   */
  setHash(hash) {}

  /**
   * @param {string} action
   */
  executeNamedAction(action) {}

  /**
   * @param {Object} params
   */
  onFileAttachmentAnnotation({ id, filename, content, }) {}

  /**
   * @param {number} pageNum - page number.
   * @param {Object} pageRef - reference to the page.
   */
  cachePageRef(pageNum, pageRef) {}
}

export {
  PDFLinkService,
  SimpleLinkService,
};
