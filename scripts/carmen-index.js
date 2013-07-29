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

if (!f) {
    console.warn('Usage: carmen-index.js <from> [to]');
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
if (t && !api[path.extname(t)]) {
    console.warn('File %s format not recognized.', t);
    process.exit(1);
}

var nogrids = ('NOGRIDS' in process.env);
if (nogrids) console.log('Indexing without grids.');

console.log('Indexing %s ...', f);

var from = new api[path.extname(f)](f, function() {});
var to = t ? new api[path.extname(t)](t, function() {}) : from;
var carmen = new Carmen({ from: from, to: to });

carmen._open(function(err) {
    if (err) throw err;
    to.startWriting(function(err) {
        if (err) throw err;
        var index = function(pointer) {
            from.indexable(pointer, function(err, docs, pointer) {
                if (err) throw err;
                if (!docs.length) {
                    var start = +new Date;
                    console.log('Storing docs...');
                    return carmen.store(to, function(err) {
                        console.log('Stored in %ss', Math.floor((+new Date-start) * 0.001));
                        if (err) throw err;
                        to.stopWriting(function(err) {
                            if (err) throw err;
                            console.log('Done.');
                            process.exit(0);
                        });
                    });
                }
                var start = +new Date;
                carmen.index(to, docs, function(err) {
                    if (err) throw err;
                    console.log('Indexed %s docs @ %s/s', docs.length, Math.floor(docs.length * 1000 / (+new Date - start)));
                    index(pointer);
                });
            });
        };
        index({nogrids:nogrids});
    });
});
