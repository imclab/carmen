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
var f = argv[2];
var t = argv[3];

if (!f || !t) {
    console.warn('Usage: carmen-copy.js <from> <to>');
    process.exit(1);
}
[f, t].forEach(function(arg) {
    if (!api[path.extname(arg)]) {
        console.warn('File %s format not recognized.', arg);
        process.exit(1);
    }
});

console.log('Copy %s => %s ...', f, t);

var from = new api[path.extname(f)](f, function() {});
var to = new api[path.extname(t)](t, function() {});
var carmen = new Carmen({ from: from, to: to });

carmen._open(function(err) {
    if (err) throw err;
    to.startWriting(function(err) {
        if (err) throw err;
        var index = function(pointer) {
            from.indexable(pointer, function(err, docs, pointer) {
                if (err) throw err;
                if (!docs.length) return to.stopWriting(function(err) {
                    if (err) throw err;
                    console.log('Done.');
                });
                var start = +new Date;
                carmen.index(to, docs, function(err) {
                    if (err) throw err;
                    console.log('Indexed %s docs @ %s/s', docs.length, Math.floor(docs.length / (+new Date - start)));
                    index(pointer);
                });
            });
        };
        index();
    });
});

