var _ = require('underscore');
var fs = require('fs');
var assert = require('assert');
var util = require('util');
var Carmen = require('..');
var S3 = Carmen.S3();
var MBTiles = Carmen.MBTiles();

// Use BACKEND=<backend> env var to specify the carmen backend to be tested.
var backend = (process.env.BACKEND||'mbtiles').toLowerCase();
if (backend !== 'mbtiles' && backend !== 's3') {
    console.warn('Backend %s unknown.', backend);
    process.exit(1);
} else {
    console.warn('Testing %s backend.', backend);
}

if (backend === 'mbtiles') var carmen = new Carmen({
    country: new MBTiles(__dirname + '/../tiles/01-ne.country.mbtiles', function(){}),
    province: new MBTiles(__dirname + '/../tiles/02-ne.province.mbtiles', function(){}),
    zipcode: new MBTiles(__dirname + '/../tiles/03-tiger.zipcode.mbtiles', function(){}),
    place: new MBTiles(__dirname + '/../tiles/04-mb.place.mbtiles', function(){})
});

function okay(type, a, b, margin) {
    var margin = margin || 0.01;
    var typecheck = type === 'place'
        ? a.type === b.type
        : a.type === type;
    return typecheck &&
        a.name === b.name &&
        (a.lon >= b.lon - margin) &&
        (a.lon <= b.lon + margin) &&
        (a.lat >= b.lat - margin) &&
        (a.lat <= b.lat + margin);
};

var summary = function(label, stats, verbose) {
    console.warn('');
    console.warn('  %s %s% (%s/%s) at %sms/query', label, (stats.okay/stats.total*100).toFixed(1), stats.okay, stats.total, (((+new Date) - stats.start)/stats.total).toFixed(1));

    if (!verbose) return;
    _(stats.failed).each(function(group, type) {
        console.warn('');
        console.warn('  ' + type);
        console.warn('  ' + new Array(type.length + 1).join('-'));
        _(group).each(function(results, name) {
            var results = results.join(', ');
            if (results.length > 40) results = results.substr(0,40) + '...';
            console.warn('  %s => %s', name, results);
        });
    });
}


_(carmen.indexes).each(function(source, type) {
    describe('geocode ' + type, function(done) {
        var queues = {
            geocode: [],
            reverse: []
        };
        var stats = {
            start: + new Date,
            total: 0,
            okay: 0,
            failed: {}
        };
        before(function(done) {
            carmen._open(function(err) {
                assert.ifError(err);
                done();
            });
        });
        before(function(done) {
            source.indexable({nogrids:true}, function(err, rows, pointer) {
                assert.ifError(err);
                queues.geocode = queues.geocode.concat(rows);
                queues.reverse = queues.reverse.concat(rows);
                done();
            });
        });
        after(function(done) {
            summary('geocode ' + type, stats, true);
            done();
        });
        var geocode = function(done) {
            if (!queues.geocode.length) return done();

            var doc = queues.geocode.shift().doc;

            // @TODO determine why some docs are without a search field.
            if (!('search' in doc)) return done();

            // @TODO some languages do not get tokenized/converted by iconv.
            if (!Carmen.tokenize(doc.name).length) return done();

            carmen.geocode(doc.name || '', function(err, res) {
                assert.ifError(err);
                stats.total++;
                var inResults = _(res.results).chain()
                    .pluck('0')
                    .any(function(r) { return okay(type, r, doc) })
                    .value();
                if (inResults) {
                    stats.okay++;
                } else {
                    stats.failed[type] = stats.failed[type] || {};
                    stats.failed[type][doc.name] = _(res.results).chain()
                        .pluck('0')
                        .map(function(r) { return r.type + '.' + r.name })
                        .uniq()
                        .value();
                }
                done();
            });
        };
        var reverse = function(done) {
            if (!queues.reverse.length) return done();

            var doc = queues.reverse.shift().doc;

            if (!('lon' in doc) || !('lat' in doc)) return done();

            var lonlat = doc.lon + ',' + doc.lat;
            carmen.geocode(lonlat, function(err, res) {
                assert.ifError(err);
                stats.total++;
                var inResults = _(res.results||[]).chain()
                    .first()
                    .any(function(r) { return okay(type, r, doc) })
                    .value();
                if (inResults) {
                    stats.okay++;
                } else {
                    stats.failed[type] = stats.failed[type] || {};
                    stats.failed[type][lonlat + ' (' + doc.name + ')'] = _(res.results||[]).chain()
                        .first()
                        .pluck('name')
                        .value();
                }
                done();
            });
        };
        var testcount = {
            'country': 400,
            'province': 400,
            'zipcode': 400,
            'place': 400
        };
        for (var i = 0; i < testcount[type]; i++) {
            it(type + ' geocode ' + i, geocode);
            it(type + ' reverse ' + i, reverse);
        }
    });
});
