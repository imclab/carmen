#!/usr/bin/env node

if (!process.argv[2]) {
    console.log('Usage: carmen.js "<query>"');
    process.exit(1);
}

var dirname = process.env.CARMEN_DIR || (__dirname + '/../tiles');

var _ = require('underscore');
var fs = require('fs');
var path = require('path');
var Carmen = require('../index');
var MBTiles = require('../api-mbtiles');
var S3 = require('../api-s3');
var opts = Carmen.autoSync(path.resolve(dirname));
var carmen = new Carmen(opts);

var load = +new Date;
carmen.geocode(process.argv[2], function(err, data) {
    if (err) throw err;
    load = +new Date - load;
    var time = +new Date;
    carmen.geocode(process.argv[2], function(err, data) {
        time = +new Date - time;
        if (err) throw err;
        var texts = data.results.reduce(function(memo, r) {
            var text = _(r).pluck('name').join(', ');
            if (!memo[text]) memo[text] = 0;
            memo[text]++;
            return memo;
        }, {});
        var keys = Object.keys(texts);
        console.log('Tokens')
        console.log('------')
        console.log(data.query.join(', '));
        console.log('');
        if (keys.length) {
            console.log('Result (showing %s of %s)', keys.slice(0,10).length, keys.length);
            console.log('-----------------------');
            keys.slice(0,10).forEach(function(key) {
                console.log('- %s %s', key, texts[key] > 1 ? 'x' + texts[key] : '');
            });
            console.log('');
        }
        console.log('Stats');
        console.log('-----');
        console.log('- warmup:    %sms', load);
        console.log('- search:    %s @ %sms', data.stats.searchCount||0, data.stats.searchTime||0);
        console.log('- score:     %s @ %sms', data.stats.scoreCount||0, data.stats.scoreTime||0);
        console.log('- results:   %s @ %sms', data.stats.contextCount||0, data.stats.contextTime||0);
        console.log('- relevance: %s', data.stats.score);
        console.log('- totaltime: %sms', time);
    });
});
