/* @requires
mapshaper-common,
mapshaper-geom,
mapshaper-shape-geom,
mapshaper-snapping,
mapshaper-topology,
mapshaper-shape-utils,
mapshaper-polygon-repair
*/

// Accumulates points in buffers until #endPath() is called
// @drain callback: function(xarr, yarr, size) {}
//
function PathImportStream(drain) {
  var buflen = 10000,
      xx = new Float64Array(buflen),
      yy = new Float64Array(buflen),
      i = 0;

  this.endPath = function() {
    drain(xx, yy, i);
    i = 0;
  };

  this.addPoint = function(x, y) {
    if (i >= buflen) {
      buflen = Math.ceil(buflen * 1.3);
      xx = utils.extendBuffer(xx, buflen);
      yy = utils.extendBuffer(yy, buflen);
    }
    xx[i] = x;
    yy[i] = y;
    i++;
  };
}

// Import path data from a non-topological source (Shapefile, GeoJSON, etc)
// in preparation for identifying topology.
// @opts.reserved_points -- estimate of points in dataset, for pre-allocating buffers
//
function PathImporter(opts) {
  var bufSize = opts.reserved_points > 0 ? opts.reserved_points : 20000,
      xx = new Float64Array(bufSize),
      yy = new Float64Array(bufSize),
      shapes = [],
      nn = [],
      collectionType = opts.type || null, // possible values: polygon, polyline, point
      round = null,
      pathId = -1,
      shapeId = -1,
      pointId = 0,
      dupeCount = 0,
      skippedPathCount = 0,
      openRingCount = 0;

  if (opts.precision) {
    round = getRoundingFunction(opts.precision);
  }

  // mix in #addPoint() and #endPath() methods
  utils.extend(this, new PathImportStream(importPathCoords));

  this.startShape = function() {
    shapes[++shapeId] = null;
  };

  this.importLine = function(points) {
    setShapeType('polyline');
    this.importPath(points);
  };

  this.importPoints = function(points) {
    setShapeType('point');
    if (round) {
      points.forEach(function(p) {
        p[0] = round(p[0]);
        p[1] = round(p[1]);
      });
    }
    points.forEach(appendToShape);
  };

  this.importRing = function(points, isHole) {
    var area = geom.getPlanarPathArea2(points);
    setShapeType('polygon');
    if (isHole === true && area > 0 || isHole === false && area < 0) {
      verbose("Warning: reversing", isHole ? "a CW hole" : "a CCW ring");
      points.reverse();
    }
    this.importPath(points);
  };

  // Import an array of [x, y] Points
  this.importPath = function importPath(points) {
    var p;
    for (var i=0, n=points.length; i<n; i++) {
      p = points[i];
      this.addPoint(p[0], p[1]);
    }
    this.endPath();
  };

  // Return topological shape data
  // Apply any requested snapping and rounding
  // Remove duplicate points, check for ring inversions
  //
  this.done = function() {
    var arcs;
    var lyr = {name: ''};

    if (collectionType == 'polygon' || collectionType == 'polyline') {

      if (dupeCount > 0) {
        verbose(utils.format("Removed %,d duplicate point%s", dupeCount, utils.pluralSuffix(dupeCount)));
      }
      if (skippedPathCount > 0) {
        // TODO: consider showing details about type of error
        message(utils.format("Removed %,d path%s with defective geometry", skippedPathCount, utils.pluralSuffix(skippedPathCount)));
      }
      if (openRingCount > 0) {
        message(utils.format("Closed %,d open polygon ring%s", openRingCount, utils.pluralSuffix(openRingCount)));
      }

      if (pointId > 0) {
        if (pointId < xx.length) {
          xx = xx.subarray(0, pointId);
          yy = yy.subarray(0, pointId);
        }
        arcs = new ArcCollection(nn, xx, yy);

        if (opts.auto_snap || opts.snap_interval) {
          MapShaper.snapCoords(arcs, opts.snap_interval);
        }
        // Detect and handle some geometry problems
        // TODO: print message summarizing any changes
        MapShaper.cleanShapes(shapes, arcs, collectionType);
      } else {
        message("No geometries were imported");
        collectionType = null;
      }
    } else if (collectionType == 'point' || collectionType === null) {
      // pass
    } else {
      error("Unexpected collection type:", collectionType);
    }

    // If shapes are all null, don't add a shapes array or geometry_type
    if (collectionType) {
      lyr.geometry_type = collectionType;
      lyr.shapes = shapes;
    }

    return {
      arcs: arcs || null,
      info: {},
      layers: [lyr]
    };
  };

  function setShapeType(t) {
    if (!collectionType) {
      collectionType = t;
    } else if (t != collectionType) {
      stop("[PathImporter] Mixed feature types are not allowed");
    }
  }

  function checkBuffers(needed) {
    if (needed > xx.length) {
      var newLen = Math.max(needed, Math.ceil(xx.length * 1.5));
      xx = utils.extendBuffer(xx, newLen, pointId);
      yy = utils.extendBuffer(yy, newLen, pointId);
    }
  }

  function appendToShape(part) {
    var currShape = shapes[shapeId] || (shapes[shapeId] = []);
    currShape.push(part);
  }

  function appendPath(n) {
    pathId++;
    nn[pathId] = n;
    appendToShape([pathId]);
  }

  function importPathCoords(xsrc, ysrc, n) {
    var count = 0;
    var x, y, prevX, prevY;
    checkBuffers(pointId + n);
    for (var i=0; i<n; i++) {
      x = xsrc[i];
      y = ysrc[i];
      if (round) {
        x = round(x);
        y = round(y);
      }
      if (i > 0 && x == prevX && y == prevY) {
        dupeCount++;
      } else {
        xx[pointId] = x;
        yy[pointId] = y;
        pointId++;
        count++;
      }
      prevY = y;
      prevX = x;
    }

    // check for open rings
    if (collectionType == 'polygon' && count > 0) {
      if (xsrc[0] != xsrc[n-1] || ysrc[0] != ysrc[n-1]) {
        checkBuffers(pointId + 1);
        xx[pointId] = xsrc[0];
        yy[pointId] = ysrc[0];
        openRingCount++;
        pointId++;
        count++;
      }
    }

    appendPath(count);
  }

}
