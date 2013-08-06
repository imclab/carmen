#!/usr/bin/env node

var dirname = process.env.CARMEN_DIR || (__dirname + '/../tiles');

var express = require('express');
var server = express.createServer();
var MBTiles = require('./api-mbtiles');
var Carmen = require('./index.js');
var path = require('path');
var opts = Carmen.autoSync(path.resolve(dirname));
var carmen = new Carmen(opts);

server.get('/geocode/:query', function(req, res, next) {
    if (!req.param('query')) return res.send(404);
    console.time('geocode ' + req.param('query'));
    carmen.geocode(req.param('query'), function(err, data) {
        console.timeEnd('geocode ' + req.param('query'));
        if (err) return next(err);
        // @TODO ...
        if (data.stats.score < 0.5) data.results = [];
        res.send(data);
    });
});

server.use(express['static'](__dirname + '/static'));

server.listen(3000);
console.log('carmen: http://localhost:3000')
