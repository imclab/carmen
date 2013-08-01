var _ = require('underscore');
var path = require('path');
var basepath = path.resolve(__dirname + '/tiles');
var sm = new (require('sphericalmercator'))();
var crypto = require('crypto');
var iconv = new require('iconv').Iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE');
var EventEmitter = require('events').EventEmitter;
var DEBUG = process.env.DEBUG;

// FNV-1a hash.
// For 32-bit: offset = 2166136261, prime = 16777619.
function fnv1a(str) {
    var hash = 0x811C9DC5;
    if (str.length) for (var i = 0; i < str.length; i++) {
        hash = hash ^ str.charCodeAt(i);
        // 2**24 + 2**8 + 0x93 = 16777619
        hash += (hash << 24) + (hash << 8) + (hash << 7) + (hash << 4) + (hash << 1);
    }
    return hash >>> 0;
};

// Resolve the UTF-8 encoding stored in grids to simple number values.
function resolveCode(key) {
    if (key >= 93) key--;
    if (key >= 35) key--;
    key -= 32;
    return key;
};

// Convert character code to UTF grid key.
function toChar(key) {
    key += 32;
    if (key >= 34) key++;
    if (key >= 92) key++;
    return String.fromCharCode(key);
};

// Clean up internal fields/prep a feature entry for external consumption.
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
            id: key,
            docs:{},
            freq:{},
            term:{},
            phrase:{},
            logs:{},
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

// Ensure that all carmen sources are opened.
Carmen.prototype._open = function(callback) {
    return this._opened ? callback(this._error) : this.once('open', callback);
};

// Returns a hierarchy of features ("context") for a given lon,lat pair.
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

// Main geocoding API entry point.
// Returns results across all indexes for a given query.
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
        var coalesced = {};

        // Coalesce scores into higher zooms, e.g.
        // z5 inherits score of overlapping tiles at z4.
        // @TODO assumes sources are in zoom ascending order.
        for (var i = 0; i < rows.length; i++) {
            var f = rows[i];
            var z = Math.floor(f.zxy[0]/1e14);
            for (var c = 0; c < f.zxy.length; c++) {
                var zxy = f.zxy[c];
                if (coalesced[zxy]) {
                    coalesced[zxy].push(f);
                } else {
                    coalesced[zxy] = [f];
                }
                var a = 0;
                var x = Math.floor((zxy % 1e14) / 1e7);
                var y = zxy % 1e7;
                while (zooms[a] < z) {
                    var p = zooms[a];
                    var s = 1 << (z-p);
                    var pxy = (p * 1e14) + (Math.floor(x/s) * 1e7) + Math.floor(y/s);
                    if (coalesced[pxy]) coalesced[zxy] = coalesced[zxy].concat(coalesced[pxy]);
                    a++;
                }
            }
        }

        var results = _(coalesced).chain()
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

                // A threshold here reduces results early.
                // @TODO tune this.
                if (score < 0.75) return memo;

                for (var i = 0, l = rows.length; i < l; i++) {
                    features[rows[i].db + '.' + rows[i].id] = rows[i];
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
        results.forEach(function(term) {
            var termid = parseInt(term.split('.')[1], 10);
            var dbname = term.split('.')[0];
            var feat = features[term].doc;
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
        for (var j = 0; j < query.length; j++) {
            if (1<<j & reason) {
                hasreason = hasreason && query[j] && ++usage;
                query[j] = false;
            }
        }
        if (hasreason) {
            score += scored[i].score;
            lastdb = scored[i].db;
        }
    }
    return score * Math.pow(usage / query.length, 2);
};

// Search a carmen source for features matching query.
Carmen.prototype.search = function(source, query, id, callback) {
    if (!this._opened) return this._open(function(err) {
        if (err) return callback(err);
        this.search(source, query, id, callback);
    }.bind(this));

    var approxdocs = source._carmen.approxdocs;
    var shardlevel = source._carmen.shardlevel;
    var terms = Carmen.terms(query);
    var freqs = source._carmen.logs;
    var docs = {};

    var getphrases = function(queue, result, callback) {
        if (!queue.length) {
            result.sort(Carmen.shardsort(shardlevel));
            result = _(result).uniq(true);
            return callback(null, result);
        }
        var shard = Carmen.shard(shardlevel, queue[0]);
        Carmen.get(source, 'term', shard, function(err, data) {
            if (err) return callback(err);
            while (shard === Carmen.shard(shardlevel, queue[0])) {
                var id = queue.shift();
                if (data[id]) {
                    data[id].sort();
                    result = result.concat(_(data[id]).uniq(true));
                }
            }
            if (!approxdocs) {
                approxdocs = Object.keys(data).length * Math.pow(16, shardlevel);
                source._carmen.approxdocs = approxdocs;
            }
            getphrases(queue, result, callback);
        });
    };

    var getterms = function(queue, result, callback) {
        if (!queue.length) {
            result.sort(Carmen.shardsort(shardlevel));
            result = _(result).uniq(true);
            return callback(null, result);
        }
        var shard = Carmen.shard(shardlevel, queue[0]);
        Carmen.get(source, 'phrase', shard, function(err, data) {
            if (err) return callback(err);
            while (shard === Carmen.shard(shardlevel, queue[0])) {
                var id = queue.shift();
                if (data[id]) result = result.concat(data[id].term);
            }
            getterms(queue, result, callback);
        });
    };

    var getfreqs = function(queue, callback) {
        if (!queue.length) return callback(null, freqs);
        var shard = Carmen.shard(shardlevel, queue[0]);
        Carmen.get(source, 'freq', shard, function(err, data) {
            if (err) return callback(err);
            while (shard === Carmen.shard(shardlevel, queue[0])) {
                var id = queue.shift();
                // @TODO error out if data[id] is missing?
                // @TODO this 1+ is a hack to ensure log is not < 0.
                // Fix this (?) by making approxdocs count accurate.
                if (!freqs[id]) freqs[id] = Math.log(1 + approxdocs/data[id]);
            }
            getfreqs(queue, callback);
        });
    };

    var getdocs = function(phrases, callback) {
        var result = [];
        for (var a = 0; a < phrases.length; a++) {
            var id = phrases[a];
            var shard = Carmen.shard(shardlevel, id);
            var data = source._carmen.phrase[shard][id];
            if (!data) throw new Error('Failed to get phrase');

            // Score each feature:
            // - across all feature synonyms, find the max score of the sum
            //   of each synonym's terms based on each term's frequency of
            //   occurrence in the dataset.
            // - for the max score also store the 'reason' -- the index of
            //   each query token that contributed to its score.
            var term = 0;
            var score = 0;
            var total = 0;
            var reason = 0;
            var termpos = -1;
            var lastpos = -1;
            var text = data.term;
            for (var i = 0; i < data.term.length; i++) {
                total += freqs[data.term[i]];
            }

            if (total < 0) throw new Error('Bad freq total ' + total);

            for (var i = 0; i < terms.length; i++) {
                term = terms[i];
                termpos = text.indexOf(term);
                if (termpos === -1) {
                    if (score !== 0) {
                        break;
                    } else {
                        continue;
                    }
                } else if (score === 0 || termpos === lastpos + 1) {
                    score += freqs[term]/total;
                    reason += 1 << i;
                    lastpos = termpos;
                }
            }
            if (score > 0.8) for (var i = 0; i < data.docs.length; i++) {
                var docid = data.docs[i];
                result.push(docid);
                if (!docs[docid] ||
                    docs[docid][0] < score ||
                    (docs[docid][0] === score && reason > docs[docid][1]))
                    docs[docid] = [score > 0.9999 ? 1 : score, reason];
            };
        }
        result.sort(Carmen.shardsort(shardlevel));
        return _(result).uniq(true);
    };

    var getzxy = function(queue, result, callback) {
        if (!queue.length) return callback(null, result);

        var shard = Carmen.shard(shardlevel, queue[0]);
        Carmen.get(source, 'docs', shard, function(err, data) {
            if (err) return callback(err);
            while (shard === Carmen.shard(shardlevel, queue[0])) {
                var id = queue.shift();
                if (data[id]) result.push(new Scored(id, docs[id][0], docs[id][1], data[id].doc, data[id].zxy));
            }
            getzxy(queue, result, callback);
        });
    };

    var termsqueue = terms.slice(0);
    termsqueue.sort(Carmen.shardsort(shardlevel));
    getphrases(termsqueue, [], function(err, phrases) {
        if (err) return callback(err);
        getterms(phrases.slice(0), [], function(err, terms) {
            if (err) return callback(err);
            getfreqs(terms, function(err) {
                if (err) return callback(err);
                var docs = getdocs(phrases);
                getzxy(docs, [], function(err, docs) {
                    if (err) return callback(err);
                    return callback(null, docs);
                });
            });
        });
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
            var phrases = doc.text.split(',').map(Carmen.phrase);
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
            doc.phrases = phrases;
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
        var patch = { docs:{}, term: {}, phrase:{} };

        docs.forEach(function(doc) {
            var docid = parseInt(doc.id,10);
            var phrases = doc.phrases;
            var termsets = doc.termsets;

            phrases.forEach(function(id, x) {
                var shard = Carmen.shard(shardlevel, id);
                patch.phrase[shard] = patch.phrase[shard] || {};
                patch.phrase[shard][id] = patch.phrase[shard][id] || {};
                patch.phrase[shard][id].term = patch.phrase[shard][id].term || termsets[x];
                patch.phrase[shard][id].docs = patch.phrase[shard][id].docs || [];
                patch.phrase[shard][id].docs.push(docid);
            });

            termsets.forEach(function(terms, x) {
                var name = phrases[x];
                var weights = [];
                var total = 0;

                for (var i = 0; i < terms.length; i++) {
                    var id = terms[i];
                    var shard = Carmen.shard(shardlevel, id);
                    var weight = Math.log(approxdocs/freq[shard][id]);
                    weights.push([id, weight]);
                    total += weight;
                }

                // Limit indexing to the *most* significant terms for a
                // document. Currently uses rough heuristic (floor+sqrt) to
                // determine how many of the top words to grab.
                weights.sort(function(a,b) {
                    return a[1] > b[1] ? -1 : a[1] < b[1] ? 1 : 0;
                });
                var sigterms = [];
                var limit = Math.floor(Math.sqrt(weights.length));
                for (var i = 0; i < limit; i++) sigterms.push(weights[i][0]);

                // Debug significant term selection.
                if (DEBUG) {
                    var debug = Carmen.termsDebug(doc.text.split(',')[x]);
                    var oldtext = terms.map(function(id) { return debug[id]; }).join(' ');
                    var sigtext = sigterms.map(function(id) { return debug[id]; }).join(' ');
                    if (oldtext !== sigtext)  console.log('%s => %s', oldtext, sigtext);
                }

                for (var i = 0; i < sigterms.length; i++) {
                    var id = sigterms[i];
                    var shard = Carmen.shard(shardlevel, id);
                    patch.term[shard] = patch.term[shard] || {};
                    patch.term[shard][id] = patch.term[shard][id] || [];
                    patch.term[shard][id].push(name);
                }
            });

            var shard = Carmen.shard(shardlevel, docid);
            patch.docs[shard] = patch.docs[shard] || {};
            patch.docs[shard][docid] = {
                doc:doc.doc,
                zxy:doc.zxy ? doc.zxy.map(Carmen.zxy) : []
            };
        });

        var remaining = 0;
        // Number of term shards.
        remaining += Object.keys(patch.term).length;
        // Number of phrase shards.
        remaining += Object.keys(patch.phrase).length;
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
                        for (var key in data) {
                            current[key] = (current[key] || []).concat(data[key]);
                        }
                        break;
                    case 'phrase':
                        for (var key in data) {
                            if (!current[key]) {
                                current[key] = data[key];
                            } else {
                                current[key].docs = current[key].docs.concat(data[key].docs);
                            }
                        }
                        break;
                    case 'docs':
                        for (var key in data) {
                            current[key] = data[key];
                        }
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
    ['freq','term','phrase','docs'].forEach(function(type) {
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

        // Remove duplicate references.
        switch (type) {
        case 'term':
            for (var key in data) {
                data[key].sort();
                data[key] = _(data[key]).uniq(true);
            }
            break;
        case 'phrase':
            for (var key in data) {
                data[key].docs.sort();
                data[key].docs = _(data[key].docs).uniq(true);
            }
            break;
        }

        Carmen.put(source, type, shard, data, function(err) {
            if (err) return callback(err);
            defer(function() { write(); });
        });
    };
    write();
};

// Normalize input text into lowercase, asciified tokens.
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
    return Carmen.tokenize(text).map(fnv1a);
};

// Converts text into a name ID.
// Appends a suffix based on the first term to help cluster phrases in shards.
Carmen.phrase = function(text) {
    var tokens = Carmen.tokenize(text);
    var a = fnv1a(tokens.join(' '));
    var b = fnv1a(tokens.length ? tokens[0] : '') % 65536;
    return (a * 65536) + b;
};

// Create a debug hash for term IDs.
Carmen.termsDebug = function(text) {
    return Carmen.tokenize(text).reduce(function(memo, w) {
        memo[fnv1a(w)] = w;
        return memo;
    }, {});
};

// Assumes an integer space of Math.pow(16,8);
Carmen.shard = function(level, id) {
    if (id === undefined) return false;
    if (level === 0) return 0;
    return id % Math.pow(16, level);
};

// Generate a sort callback method that sorts by shard.
Carmen.shardsort = function(level) {
    var mod = Math.pow(16, level);
    return function(a,b) {
        var as = a % mod;
        var bs = b % mod;
        return as < bs ? -1 : as > bs ? 1 : a < b ? -1 : a > b ? 1 : 0;
    };
};

// Converts zxy coordinates into an array of zxy IDs.
Carmen.zxy = function(zxy) {
    zxy = zxy.split('/');
    return ((zxy[0]|0) * 1e14) + ((zxy[1]|0) * 1e7) + (zxy[2]|0);
};

// Get data from a carmen source.
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

// Put data to a carmen source.
Carmen.put = function(source, type, shard, data, callback) {
    var shards = source._carmen[type];
    var json = JSON.stringify(data);
    source.putCarmen(type, shard, json, function(err) {
        if (err) return callback(err);
        shards[shard] = data;
        callback(null);
    });
};

// Locking event emitter for consolidating I/O for identical requests.
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

// Prototype for scored rows of Carmen.search.
// Defined to take advantage of V8 class performance.
function Scored(id, score, reason, doc, zxy) {
    this.id = id;
    this.score = score;
    this.reason = reason;
    this.doc = doc;
    this.zxy = zxy;
};

module.exports = Carmen;
