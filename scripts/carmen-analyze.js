#!/usr/bin/env node

var fs = require('fs');
var path = require('path');
var argv = process.argv;
var api = {
    '.s3': require('../api-s3'),
    '.mbtiles': require('../api-mbtiles')
};
var Carmen = require('../index.js');
var Queue = require('../queue');
var _ = require('underscore');
var f = argv[2];

if (!f) {
    console.warn('Usage: carmen-analyze.js <file>');
    process.exit(1);
}
if (!fs.existsSync(f)) {
    console.warn('File %s does not exist.', f);
    process.exit(1);
}
if (!api[path.extname(f)]) {
    console.warn('File %s format not recognized.', f);
    process.exit(1);
}

console.log('Analyzing %s ...', f);

var s = new api[path.extname(f)](f, function() {});
var carmen = new Carmen({ s: s });
var stats = {};

carmen._open(function(err) {
    if (err) throw err;
    var shardlevel = s._carmen.shardlevel;
    stats.shardlevel = shardlevel;
    stats.term = {
        min:Infinity,
        max:0,
        mean:0,
        count:0,
        maxes:[]
    };
    stats.grid = {
        min:Infinity,
        max:0,
        mean:0,
        count:0,
        maxes:[]
    };

    function termlookup(maxes, i, callback) {
        if (i >= maxes.length) return callback();
        var term = maxes[i][0];
        var grid = maxes[i][2];
        var shard = Carmen.shard(shardlevel, grid);
        Carmen.get(s, 'grid', shard, function(err, data) {
            if (err) return callback(err);
            if (!data[grid]) return callback(new Error('Grid ' + grid + ' not found'));
            var id = Carmen.intload([], data[grid][0])[0];
            s.getFeature(id, function(err, doc) {
                if (err) return callback(err);
                var text = doc.search || doc.name || '';
                var query = Carmen.tokenize(text);
                var terms = Carmen.terms(text);
                var idx = terms.indexOf(+term);
                if (idx !== -1) {
                    maxes[i].unshift(query[idx]);
                } else {
                    maxes[i].unshift(text);
                }
                termlookup(maxes, ++i, callback);
            });
        });
    };

    function phraselookup(maxes, i, callback) {
        if (i >= maxes.length) return callback();
        var grid = maxes[i][0];
        var shard = Carmen.shard(shardlevel, grid);
        Carmen.get(s, 'grid', shard, function(err, data) {
            if (err) return callback(err);
            if (!data[grid]) return callback(new Error('Grid ' + grid + ' not found'));
            var id = Carmen.intload([], data[grid][0])[0];
            s.getFeature(id, function(err, doc) {
                if (err) return callback(err);
                var text = doc.search || doc.name || '';
                _(text.split(',')).each(function(syn) {
                    if (Carmen.phrase(syn) === +grid) {
                        maxes[i].unshift(Carmen.tokenize(syn).join(' '));
                    }
                });
                phraselookup(maxes, ++i, callback);
            });
        });
    };

    function relstats(type, i, callback) {
        i = i || 0;

        var rels;
        var uniq;
        var list;
        var stat = stats[type];

        // If complete or on a 100th run go through maxes.
        if (i >= Math.pow(16, shardlevel) || (i % 100) === 0) {
            stat.maxes.sort(function(a, b) {
                return a[1] > b[1] ? -1 : a[1] < b[1] ? 1 : 0;
            });
            stat.maxes = stat.maxes.slice(0,10);
        }

        // Done.
        if (i >= Math.pow(16, shardlevel)) {
            return type === 'term'
                ? termlookup(stat.maxes, 0, callback)
                : phraselookup(stat.maxes, 0, callback);
        }

        Carmen.get(s, type, i, function(err, data) {
            if (err) return callback(err);
            for (var id in data) {
                list = type === 'term'
                    ? Carmen.intload([], data[id])
                    : data[id].map(function(intstring) { return Carmen.intload([], intstring) });
                rels = list.length;

                // Verify that relations are unique.
                list.sort();
                if (rels !== _(list).uniq(true).length) {
                    console.warn(type + '.' + id + ' has non-unique relations: ' + list);
                }

                stat.min = Math.min(stat.min, rels);
                stat.max = Math.max(stat.max, rels);
                stat.mean = ((stat.mean * stat.count) + rels) / (stat.count + 1);
                stat.count++;
                stat.maxes.push([id,rels,list[0]]);
            }
            relstats(type, ++i, callback);
        });
    };

    relstats('term', 0, function(err) {
        if (err) throw err;
        relstats('grid', 0, function(err) {
            if (err) throw err;
            console.log('term <=> phrase index');
            console.log('---------------------');
            _(stats.term).each(function(val, key) {
                if (key === 'maxes') {
                    console.log('- %s:', key);
                    _(val).each(function(entry, i) {
                        console.log('  %s. %s (%s) %s', i+1, entry[0], entry[1], entry[2]);
                    });
                } else {
                    console.log('- %s: %s', key, val);
                }
            });

            console.log('');

            console.log('phrase <=> grid index');
            console.log('--------------------');
            _(stats.grid).each(function(val, key) {
                if (key === 'maxes') {
                    console.log('- %s:', key);
                    _(val).each(function(entry, i) {
                        console.log('  %s. %s (%s) %s', i+1, entry[0], entry[1], entry[2]);
                    });
                } else {
                    console.log('- %s: %s', key, val);
                }
            });
        });
    });
});
