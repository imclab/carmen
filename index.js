var _ = require('underscore');
var path = require('path');
var basepath = path.resolve(__dirname + '/tiles');
var sm = new (require('sphericalmercator'))();
var crypto = require('crypto');
var iconv = new require('iconv').Iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE');
var EventEmitter = require('events').EventEmitter;

// For a given z,x,y find its parent tile.
function pyramid(zxy, parent) {
    var z = (zxy / 1e14) | 0;
    var x = ((zxy % 1e14) / 1e7) | 0;
    var y = zxy % 1e7;
    var depth = Math.max(z - parent, 0);
    var side = Math.pow(2, depth);
    return ((z - depth) * 1e14) + (Math.floor(x/side) * 1e7) + Math.floor(y/side);
};

// Resolve the UTF-8 encoding stored in grids to simple number values.
function resolveCode(key) {
    if (key >= 93) key--;
    if (key >= 35) key--;
    key -= 32;
    return key;
};

function toChar(key) {
    key += 32;
    if (key >= 34) key++;
    if (key >= 92) key++;
    return String.fromCharCode(key);
};

function feature(id, type, data) {
    data.id = type + '.' + id;
    data.type = data.type || type;
    if ('string' === typeof data.bounds)
        data.bounds = data.bounds.split(',').map(parseFloat);
    if ('search' in data)
        delete data.search;
    if ('rank' in data)
        delete data.rank;
    return data;
};

require('util').inherits(Carmen, EventEmitter);

function Carmen(options) {
    if (!options) throw new Error('Carmen options required.');

    var remaining = Object.keys(options).length;
    var done = function(err) {
        if (!--remaining || err) {
            remaining = -1;
            this._error = err;
            this._opened = true;
            this.emit('open', err);
        }
    }.bind(this);

    this.indexes = _(options).reduce(function(memo, source, key) {
        // Legacy support.
        source = source.source ? source.source : source;

        memo[key] = source;
        source._carmen = source._carmen || {
            docs:{},
            freq:{},
            term:{},
            grid:{},
            cache:{}
        };
        if (source.open) {
            source.getInfo(function(err, info) {
                if (err) return done(err);
                source._carmen.zoom = info.maxzoom;
                source._carmen.shardlevel = info.shardlevel || 0;
                return done();
            });
        } else {
            source.once('open', function(err) {
                if (err) return done(err);
                source.getInfo(function(err, info) {
                    if (err) return done(err);
                    source._carmen.zoom = info.maxzoom;
                    source._carmen.shardlevel = info.shardlevel || 0;
                    return done();
                });
            });
        }
        return memo;
    }, {});
};

Carmen.S3 = function() { return require('./api-s3') };
Carmen.MBTiles = function() { return require('./api-mbtiles') };

Carmen.prototype._open = function(callback) {
    return this._opened ? callback(this._error) : this.once('open', callback);
};

Carmen.prototype.context = function(lon, lat, maxtype, callback) {
    if (!this._opened) return this._open(function(err) {
        if (err) return callback(err);
        this.context(lon, lat, maxtype, callback);
    }.bind(this));

    var context = [];
    var indexes = this.indexes;
    var types = Object.keys(indexes);
    types = types.slice(0, maxtype ? types.indexOf(maxtype) : types.length);
    var remaining = types.length;

    // No-op context.
    if (!remaining) return callback(null, context);

    var scan = [
        [0,0],
        [0,1],
        [0,-1],
        [1,0],
        [1,1],
        [1,-1],
        [-1,0],
        [-1,1],
        [-1,-1]
    ];

    types.forEach(function(type, pos) {
        var source = indexes[type];
        var zoom = source._carmen.zoom;
        var xyz = sm.xyz([lon,lat,lon,lat], zoom);
        var ckey = (zoom * 1e14) + (xyz.minX * 1e7) + xyz.minY;
        var cache = source._carmen.cache;

        function done(err, grid) {
            if (err && err.message !== 'Grid does not exist') {
                remaining = 0;
                return callback(err);
            }
            if (grid) {
                var resolution = 4;
                var px = sm.px([lon,lat], zoom);
                var y = Math.round((px[1] % 256) / resolution);
                var x = Math.round((px[0] % 256) / resolution);
                x = x > 63 ? 63 : x;
                y = y > 63 ? 63 : y;
                var key, sx, sy;
                for (var i = 0; i < scan.length; i++) {
                    sx = x + scan[i][0];
                    sy = y + scan[i][1];
                    sx = sx > 63 ? 63 : sx < 0 ? 0 : sx;
                    sy = sy > 63 ? 63 : sy < 0 ? 0 : sy;
                    key = grid.keys[resolveCode(grid.grid[sy].charCodeAt(sx))];
                    if (key) {
                        context[pos] = key && feature(key, type, grid.data[key]);
                        break;
                    }
                }
            }
            if (!--remaining) {
                context.reverse();
                return callback(null, context.filter(function(v) { return v }));
            }
        };
        if (cache[ckey] && cache[ckey].open) {
            done(null, cache[ckey].data);
        } else if (cache[ckey]) {
            cache[ckey].once('open', done);
        } else {
            cache[ckey] = new Locking();
            source.getGrid(zoom, xyz.minX, xyz.minY, cache[ckey].loader(done));
        }
    });
};

// Retrieve the context for a feature (document).
Carmen.prototype.contextByFeature = function(data, callback) {
    if (!'lon' in data) return callback(new Error('No lon field in data'));
    if (!'lat' in data) return callback(new Error('No lat field in data'));
    var carmen = this;
    this.context(data.lon, data.lat, data.id.split('.')[0], function(err, context) {
        if (err) return callback(err);

        // Push feature onto the top level.
        context.unshift(data);
        return callback(null, context);
    });
};

Carmen.prototype.geocode = function(query, callback) {
    if (!this._opened) return this._open(function(err) {
        if (err) return callback(err);
        this.geocode(query, callback);
    }.bind(this));

    var indexes = this.indexes;
    var types = Object.keys(indexes);
    var zooms = [];
    var data = {
        query: Carmen.tokenize(query, true),
        stats: {}
    };
    var carmen = this;

    // lon,lat pair. Provide the context for this location.
    if (data.query.length === 2 && _(data.query).all(_.isNumber)) {
        return this.context(data.query[0], data.query[1], null, function(err, context) {
            if (err) return callback(err);
            data.results = context.length ? [context] : [];
            return callback(null, data);
        });
    }

    // keyword search. Find matching features.
    data.stats.searchTime = +new Date;

    function search(callback) {
        var result = [];
        var remaining = types.length;
        types.forEach(function(dbname, pos) {
            carmen.search(indexes[dbname], data.query.join(' '), null, function(err, rows) {
                if (err) {
                    remaining = 0;
                    return callback(err);
                }
                if (rows.length) {
                    var z = rows[0].zxy[0]/1e14|0;
                    if (zooms.indexOf(z) === -1) zooms.push(z);
                    for (var j = 0, l = rows.length; j < l; j++) {
                        rows[j].db = dbname;
                        rows[j].tmpid = (types.indexOf(dbname) * 1e14 + rows[j].id);
                    }
                }
                result[pos] = rows;
                if (!--remaining) {
                    zooms = zooms.sort(function(a,b) { return a < b ? -1 : 1 });
                    result = result.concat.apply([], result);
                    data.stats.searchTime = +new Date - data.stats.searchTime;
                    data.stats.searchCount = result.length;
                    data.stats.scoreTime = +new Date;
                    callback(null, result, zooms);
                }
            });
        });
    };

    function score(rows, zooms, callback) {
        var features = {};
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            features[row.tmpid] = row;
            features[row.db + '.' + row.id] = row;
        }

        var results = _(rows).chain()
            // Coalesce scores into higher zooms, e.g.
            // z5 inherits score of overlapping tiles at z4.
            // @TODO assumes sources are in zoom ascending order.
            .reduce(function(memo, row) {
                var sourcezoom = row.zxy[0]/1e14|0;
                for (var a = 0; zooms[a] <= sourcezoom; a++) {
                    var z = zooms[a];
                    var f = features[row.tmpid];
                    for (var c = 0; c < row.zxy.length; c++) {
                        var zxy = row.zxy[c];
                        memo[zxy] = memo[zxy] || [];
                        if (memo[zxy].indexOf(f) === -1) memo[zxy].push(f);

                        var pxy = pyramid(zxy, z);
                        if (!memo[pxy]) continue;
                        for (var d = 0; d < memo[pxy].length; d++) {
                            if (memo[zxy].indexOf(memo[pxy][d]) >= 0) continue;
                            memo[zxy].push(memo[pxy][d]);
                        }
                    }
                }
                return memo;
            }, {})
            .reduce(function(memo, rows) {
                // Sort by db, score such that total score can be
                // calculated without results for the same db being summed.
                rows.sort(function(a, b) {
                    var ai = types.indexOf(a.db);
                    var bi = types.indexOf(b.db);
                    if (ai < bi) return -1;
                    if (ai > bi) return 1;
                    if (a.score > b.score) return -1;
                    if (a.score < b.score) return 1;
                    return 0;
                });
                var score = Carmen.usagescore(data.query, rows);
                for (var i = 0, l = rows.length; i < l; i++) {
                    memo[rows[i].tmpid] = memo[rows[i].tmpid] || {
                        db: rows[i].db,
                        id: rows[i].id,
                        tmpid: rows[i].tmpid,
                        score: score
                    };
                }
                return memo;
            }, {})
            .sortBy(function(feature) { return -1 * feature.score })
            .reduce(function(memo, feature) {
                if (!memo.length || memo[0].score - feature.score < 0.5) {
                    memo.push(feature);
                }
                return memo;
            }, [])
            .map(function(f) { return f.db + '.' + f.id; })
            .value();

        data.stats.scoreTime = +new Date - data.stats.scoreTime;
        data.stats.scoreCount = results.length;

        if (!results.length) return callback(null, results);

        var start = +new Date;
        var matches = [];
        var contexts = [];
        var remaining = results.length;
        results.forEach(function(terms) {
            var term = terms.split(',')[0];
            var termid = parseInt(term.split('.')[1], 10);
            var dbname = term.split('.')[0];
            var shard = Carmen.shard(indexes[dbname]._carmen.shardlevel, termid);
            Carmen.get(indexes[dbname], 'docs', shard, function(err, docs) {
                if (err) return (remaining = 0) && callback(err);
                if (!docs[termid]) return (remaining = 0) && callback(new Error('No doc for ' + termid));
                var feat = docs[termid];
                carmen.contextByFeature(feature(termid, dbname, feat), function(err, context) {
                    if (err) return (remaining = 0) && callback(err);
                    contexts.push(context);
                    if (!--remaining) {
                        data.stats.contextTime = +new Date - start;
                        data.stats.contextCount = contexts.length;
                        return callback(null, contexts, features);
                    }
                });
            });
        });
    };

    search(function(err, rows, zooms) {
        if (err) return callback(err);
        score(rows, zooms, function(err, contexts, features) {
            if (err) return callback(err);

            // Confirm that the context contains the terms that contributed
            // to the match's score. All other contexts are false positives
            // and should be discarded. Example:
            //
            //     "Chester, NJ" => "Chester, PA"
            //
            // This context will be returned because Chester, PA is in
            // close enough proximity to overlap with NJ.
            var maxscore = 0;
            var results = contexts.reduce(function(memo, c) {
                var scored = [];
                for (var i = 0; i < c.length; i++) {
                    if (features[c[i].id]) scored.push(features[c[i].id]);
                }
                var score = Carmen.usagescore(data.query, scored);
                if (!memo.length || score === maxscore) {
                    memo.push(c);
                    maxscore = score;
                    return memo;
                } else if (score > maxscore) {
                    maxscore = score;
                    return [c];
                } else {
                    return memo;
                }
            }, []);
            results.sort(function(a, b) {
                a = a[0], b = b[0];

                // primary sort by result's index.
                var adb = a.id.split('.')[0];
                var bdb = b.id.split('.')[0];
                var ai = types.indexOf(adb);
                var bi = types.indexOf(bdb);
                if (ai < bi) return -1;
                if (ai > bi) return 1;

                // secondary sort by score key.
                var as = a.score || 0;
                var bs = b.score || 0;
                if (as > bs) return -1;
                if (as < bs) return 1;

                // last sort by id.
                if (a.id > b.id) return -1;
                if (a.id < b.id) return 1;
                return 0;
            });
            data.results = results;
            data.stats.score = maxscore;

            return callback(null, data);
        });
    });
};

// Return a "usage" score by comparing a set of scored elements against the
// input query. Each scored element must include the following keys: score,
// reason, db.
Carmen.usagescore = function(query, scored) {
    // Clone original query tokens. These will be crossed off one
    // by one to ensure each query token only counts once towards
    // the final score.
    var query = query.slice(0);

    var score = 0;
    var usage = 0;
    var lastdb = false;

    for (var i = 0; i < scored.length; i++) {
        if (lastdb === scored[i].db) continue;

        var hasreason = true;
        var reason = scored[i].reason;
        for (var j = 0; j < reason.length; j++) {
            hasreason = hasreason && query[reason[j]] && ++usage;
            query[reason[j]] = false;
        }
        if (hasreason) {
            score += scored[i].score;
            lastdb = scored[i].db;
        }
    }
    return score * Math.pow(usage / query.length, 2);
};

Carmen.prototype.search = function(source, query, id, callback) {
    if (!this._opened) return this._open(function(err) {
        if (err) return callback(err);
        this.search(source, query, id, callback);
    }.bind(this));

    var approxdocs = 0;
    var shardlevel = source._carmen.shardlevel;
    var terms = Carmen.terms(query);
    var freqs = {};

    var getids = function(queue, result, callback) {
        // @TODO do this mostfreq operation in a way where result id frequency
        // must be adjacent in the original query, e.g. such that the following
        // does not occur:
        //
        // new washington york
        // => new york (x2 id freq)
        // => washington (x1 id freq)
        if (!queue.length) return callback(null, Carmen.mostfreq(result));

        var term = queue.shift();
        var shard = Carmen.shard(shardlevel, term);
        Carmen.get(source, 'term', shard, function(err, data) {
            if (err) return callback(err);
            if (!data[term]) return getids(queue, result, callback);

            // Calculate approx doc count once.
            if (!approxdocs) approxdocs = Object.keys(data).length * Math.pow(16, shardlevel);

            result = result.concat(data[term]);
            getids(queue, result, callback);
        });
    };

    var getzxy = function(queue, result, callback) {
        if (!queue.length) return callback(null, result);

        var id = queue.shift();
        var shard = Carmen.shard(shardlevel, id);

        Carmen.get(source, 'grid', shard, function(err, data) {
            if (err) return callback(err);
            if (!data[id]) return getzxy(queue, result, callback);
            termfreq(Array.prototype.concat.apply([], data[id].text), function(err) {
                if (err) return callback(err);

                // Score each feature:
                // - across all feature synonyms, find the max score of the sum
                //   of each synonym's terms based on each term's frequency of
                //   occurrence in the dataset.
                // - for the max score also store the 'reason' -- the index of
                //   each query token that contributed to its score.
                var score = 0;
                var reason = [];
                for (var i = 0; i < data[id].text.length; i++) {
                    var total = 0;
                    var localScore = 0;
                    var localReason = [];
                    var text = data[id].text[i];

                    for (var j = 0; j < text.length; j++) {
                        total += freqs[text[j]];
                    }

                    var term = 0;
                    var termpos = -1;
                    var lastpos = -1;
                    for (var j = 0; j < terms.length; j++) {
                        term = terms[j];
                        termpos = text.indexOf(term);

                        if (termpos === -1) {
                            if (localReason.length) {
                                break;
                            } else {
                                continue;
                            }
                        } else if (localReason.length === 0 || termpos === lastpos + 1) {
                            localScore += freqs[term]/total;
                            localReason.push(j);
                            lastpos = termpos;
                        }
                    }
                    if (localScore > score) {
                        score = localScore;
                        reason = localReason;
                    }
                }

                if (score > 0.6) result.push({
                    id: id,
                    // patch up javascript float precision errors -- scores
                    // that should add to 1 sometimes come back as 0.99999...
                    score: score > 0.9999 ? 1 : score,
                    reason: reason,
                    zxy: data[id].zxy
                });
                getzxy(queue, result, callback);
            });
        });
    };

    var termfreq = function(terms, callback) {
        if (!terms.length) return callback();
        var term = terms.shift();

        // Term frequency is already known. Continue.
        if (freqs[term]) return termfreq(terms, callback);

        // Look up term frequency.
        var shard = Carmen.shard(shardlevel, term);
        Carmen.get(source, 'freq', shard, function(err, data) {
            if (err) return callback(err);
            freqs[term] = Math.log(approxdocs / data[term]);
            return termfreq(terms, callback);
        });
    };

    getids([].concat(terms), [], function(err, ids) {
        if (err) return callback(err);
        getzxy(ids, [], callback);
    });
};

// Add docs to a source's index.
Carmen.prototype.index = function(source, docs, callback) {
    if (!this._opened) return this._open(function(err) {
        if (err) return callback(err);
        this.index(source, docs, callback);
    }.bind(this));

    var shardlevel = source._carmen.shardlevel;

    indexFreqs(function(err, freq) {
        if (err) return callback(err);
        Carmen.get(source, 'freq', 0, function(err, data) {
            if (err) return callback(err);
            // @TODO fix this approxdoc calc.
            var approxdocs = Object.keys(data).length * Math.pow(16, shardlevel);
            approxdocs = approxdocs || Object.keys(freq).length;
            indexDocs(approxdocs, freq, callback);
        });
    });

    // First pass over docs.
    // - Creates termsets (one or more arrays of termids) from document text.
    // - Tallies frequency of termids against current frequencies compiling a
    //   final in-memory frequency count of all terms involved with this set of
    //   documents to be indexed.
    // - Stores new frequencies.
    function indexFreqs(callback) {
        var remaining = 0;
        var freq = {};
        for (var i = 0; i < docs.length; i++) {
            var doc = docs[i];
            var termsets = doc.text.split(',').map(Carmen.terms);
            for (var j = 0; j < termsets.length; j++) {
                var terms = termsets[j];
                for (var k = 0; k < terms.length; k++) {
                    var id = terms[k];
                    var shard = Carmen.shard(shardlevel, id);
                    freq[shard] = freq[shard] || {};
                    freq[shard][id] = freq[shard][id] || 0;
                    freq[shard][id]++;
                }
            }
            doc.termsets = termsets;
        }
        var remaining = Object.keys(freq).length;
        _(freq).each(function(data, shard) {
            Carmen.get(source, 'freq', shard, function(err, current) {
                for (var key in data) current[key] = (current[key]||0) + data[key];
                if (!--remaining) callback(null, source._carmen.freq);
            });
        });
    };

    // Second pass over docs.
    // - Create term => docid index. Uses calculated frequencies to index only
    //   significant terms for each document.
    // - Create id => grid zxy index.
    function indexDocs(approxdocs, freq, callback) {
        var patch = { docs:{}, term: {}, grid: {} };

        docs.forEach(function(doc) {
            var docid = parseInt(doc.id,10);
            var termsets = doc.termsets;
            var termsmem = [];
            termsets.forEach(function(terms, x) {
                var weights = {};
                var total = 0;

                for (var i = 0; i < terms.length; i++) {
                    var id = terms[i];
                    var shard = Carmen.shard(shardlevel, id);
                    weights[id] = Math.log(approxdocs/freq[shard][id]);
                    total += weights[id];
                }

                // This threshold defines broadly how significant a term
                // must be within the context of a document to be indexed.
                // Indexing of only significant terms is an optimization meant
                // to reduce the burden of indexing high cardinality terms
                // (e.g. road, lane, way, etc.) when they are insignificant
                // within the context of a document.
                //
                // *Intended* to preserve indexing of high cardinality terms
                // when they are of relative importance within a document
                // context, e.g. alley from "alley street".
                //
                // Examples:
                //
                // kalorama road
                // - since this document has 2 terms, a significant term is
                //   as one with weight >= 0.25 (1/2/2 = 0.25).
                //
                // united states of america
                // - since this document has 4 terms, a significant term is
                //   as one with weight >= 0.125 (1/4/2 = 0.125).
                var threshold = 1 / terms.length / 2;

                var sigterms = [];
                for (var i = 0; i < terms.length; i++) {
                    var id = terms[i];
                    if ((weights[id]/total) >= threshold) sigterms.push(id);
                }

                // Debug significant term selection.
                // var debug = Carmen.termsDebug(doc.text.split(',')[x]);
                // var oldtext = terms.map(function(id) { return debug[id]; }).join(' ');
                // var sigtext = sigterms.map(function(id) { return debug[id]; }).join(' ');
                // if (oldtext !== sigtext)  console.log('%s => %s', oldtext, sigtext);

                for (var i = 0; i < sigterms.length; i++) {
                    var id = sigterms[i];
                    var shard = Carmen.shard(shardlevel, id);
                    if (termsmem.indexOf(id) !== -1) continue;
                    patch.term[shard] = patch.term[shard] || {};
                    patch.term[shard][id] = patch.term[shard][id] || [];
                    patch.term[shard][id].push(docid);
                    termsmem.push(id);
                }
            });

            var shard = Carmen.shard(shardlevel, docid);
            patch.docs[shard] = patch.docs[shard] || {};
            patch.docs[shard][docid] = doc.doc;
            if (doc.zxy) {
                patch.grid[shard] = patch.grid[shard] || {};
                patch.grid[shard][docid] = {
                    text: doc.termsets,
                    zxy: doc.zxy.map(Carmen.zxy)
                };
            }
        });

        var remaining = 0;
        // Number of term shards.
        remaining += Object.keys(patch.term).length;
        // Number of grid shards.
        remaining += Object.keys(patch.grid).length;
        // Number of docs shards.
        remaining += Object.keys(patch.docs).length;

        _(patch).each(function(shards, type) {
            _(shards).each(function(data, shard) {
                Carmen.get(source, type, shard, function(err, current) {
                    if (err && remaining > 0) {
                        remaining = -1;
                        return callback(err);
                    }
                    // This merges new entries on top of old ones.
                    switch (type) {
                    case 'term':
                        for (var key in data) current[key] = (current[key] || []).concat(data[key]);
                        break;
                    case 'grid':
                    case 'docs':
                        for (var key in data) current[key] = data[key];
                        break;
                    }
                    if (!--remaining) callback(null);
                });
            });
        });
    };
};

// Serialize and make permanent the index currently in memory for a source.
Carmen.prototype.store = function(source, callback) {
    if (!this._opened) return this._open(function(err) {
        if (err) return callback(err);
        this.store(source, callback);
    }.bind(this));

    var queue = [];
    ['freq','term','grid','docs'].forEach(function(type) {
        queue = queue.concat(Object.keys(source._carmen[type]).map(function(shard) {
            return [type, shard];
        }));
    });

    var write = function() {
        if (!queue.length) return callback();
        var task = queue.shift();
        var type = task[0];
        var shard = task[1];
        var data = source._carmen[type][shard];
        Carmen.put(source, type, shard, data, function(err) {
            if (err) return callback(err);
            defer(function() { write(); });
        });
    };
    write();
};

Carmen.tokenize = function(query, lonlat) {
    if (lonlat) {
        var numeric = query.
            split(/[^\.\-\d+]+/i)
            .filter(function(t) { return t.length })
            .map(function(t) { return parseFloat(t) })
            .filter(function(t) { return !isNaN(t) });
        if (numeric.length === 2) return numeric;
    }

    try {
        var converted = iconv.convert(query).toString();
        query = converted;
    } catch(err) {}

    return query
        .toLowerCase()
        .replace(/[\^]+/g, '')
        .replace(/[-,]+/g, ' ')
        .split(/[^\w+^\s+]/gi)
        .join('')
        .split(/[\s+]+/gi)
        .filter(function(t) { return t.length });
};

// Converts text into an array of search term hash IDs.
Carmen.terms = function(text) {
    var terms = Carmen.tokenize(text).map(function(w) {
        return parseInt(crypto.createHash('md5').update(w).digest('hex').substr(0,8), 16);
    });
    return _(terms).uniq();
};

// Create a debug hash for term IDs.
Carmen.termsDebug = function(text) {
    return Carmen.tokenize(text).reduce(function(memo, w) {
        memo[parseInt(crypto.createHash('md5').update(w).digest('hex').substr(0,8), 16)] = w;
        return memo;
    }, {});
};

// Assumes an integer space of Math.pow(16,8);
Carmen.shard = function(level, id) {
    if (level === 0) return 0;
    return id % Math.pow(16, level);
};

// Converts zxy coordinates into an array of zxy IDs.
Carmen.zxy = function(zxy) {
    zxy = zxy.split('/');
    return ((zxy[0]|0) * 1e14) + ((zxy[1]|0) * 1e7) + (zxy[2]|0);
};

// Return an array of values with the highest frequency from the original array.
Carmen.mostfreq = function(list) {
    if (!list.length) return [];
    list.sort();
    var values = [];
    var maxfreq = 1;
    var curfreq = 1;
    do {
        var current = list.shift();
        if (current === list[0]) {
            curfreq++;
            if (curfreq > maxfreq) {
                maxfreq = curfreq;
                values = [current];
            } else if (curfreq === maxfreq && values.indexOf(current) === -1) {
                values.push(current);
            }
        } else if (maxfreq === 1) {
            values.push(current);
            curfreq = 1;
        } else {
            curfreq = 1;
        }
    } while (list.length);
    return values;
};

var defer = typeof setImmediate === 'undefined' ? process.nextTick : setImmediate;
Carmen.get = function(source, type, shard, callback) {
    var shards = source._carmen[type];
    if (shards[shard]) return defer(function() {
        callback(null, shards[shard]);
    });
    source.getCarmen(type, shard, function(err, data) {
        if (err) return callback(err);
        shards[shard] = data ? JSON.parse(data) : {};
        callback(null, shards[shard]);
    });
};

Carmen.put = function(source, type, shard, data, callback) {
    var shards = source._carmen[type];
    var json = JSON.stringify(data);
    source.putCarmen(type, shard, json, function(err) {
        if (err) return callback(err);
        shards[shard] = data;
        callback(null);
    });
};

require('util').inherits(Locking, EventEmitter);

function Locking() { this.setMaxListeners(0); };

Locking.prototype.loader = function(callback) {
    var locking = this;
    return function(err, data) {
        locking.open = true;
        locking.data = data;
        locking.emit('open', err, data);
        callback(err, data);
    };
};

module.exports = Carmen;
