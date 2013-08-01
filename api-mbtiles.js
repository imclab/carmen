var _ = require('underscore');
var iconv = new require('iconv').Iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE');
var crypto = require('crypto');
var Parent = require('mbtiles');

module.exports = MBTiles;
require('util').inherits(MBTiles, Parent);

function MBTiles(uri, callback) {
    return Parent.call(this, uri, function(err, source) {
        source.emit('open', err);
        callback(err, source);
    });
};

// Implements carmen#getFeature method.
MBTiles.prototype.getFeature = function(id, callback) {
    this._db.get('SELECT key_name AS id, key_json AS data FROM keymap WHERE key_name = ?', id, function(err, row) {
        if (err) return callback(err);
        try { return callback(null, JSON.parse(row.data)); }
        catch(err) { return callback(err); }
    });
};

// Implements carmen#putFeature method.
MBTiles.prototype.putFeature = function(id, data, callback) {
    this.write('keymap', id, {
        key_name: id,
        key_json: JSON.stringify(data)
    }, callback);
};

// Implements carmen#getCarmen method.
MBTiles.prototype.getCarmen = function(type, shard, callback) {
    return this._db.get('SELECT data FROM carmen_' + type + ' WHERE shard = ?', shard, function(err, row) {
        callback(err, row ? row.data : null);
    });
};

// Implements carmen#putCarmen method.
MBTiles.prototype.putCarmen = function(type, shard, data, callback) {
    this.write('carmen_' + type, shard, { shard: shard, data: data }, callback);
};

// Implements carmen#indexable method.
MBTiles.prototype.indexable = function(pointer, callback) {
    pointer = pointer || {};
    pointer.limit = pointer.limit || 10000;
    pointer.offset = pointer.offset || 0;
    pointer.nogrids = 'nogrids' in pointer ? pointer.nogrids : false;

    // Converts MBTiles native TMS coords to ZXY.
    function tms2zxy(zxys) {
        return zxys.split(',').map(function(tms) {
            var zxy = tms.split('/').map(function(v) { return parseInt(v,10) });
            zxy[2] = (1 << zxy[0]) - 1 - zxy[2];
            return zxy.join('/');
        });
    };

    // If 'carmen' option is passed in initial pointer, retrieve indexables from
    // carmen table. This option can be used to access the previously indexed
    // documents from an MBTiles database without having to know what search
    // field was used in the past (see comment below).
    if (pointer.table === 'carmen') return this._db.all("SELECT c.id, c.text, c.zxy, k.key_json FROM carmen c JOIN keymap k ON c.id = k.key_name LIMIT ? OFFSET ?", pointer.limit, pointer.offset, function(err, rows) {
        if (err) return callback(err);
        var docs = rows.map(function(row) {
            var doc = {};
            doc.id = row.id;
            doc.doc = JSON.parse(row.key_json);
            doc.text = row.text;
            if (row.zxy) doc.zxy = tms2zxy(row.zxy);
            return doc;
        });
        pointer.offset += pointer.limit;
        return callback(null, docs, pointer);
    }.bind(this));

    // By default the keymap table contains all indexable documents.
    this.getInfo(function(err, info) {
        if (err) return callback(err);
        if (pointer.nogrids) {
            var sql = "SELECT key_name, key_json FROM keymap LIMIT ? OFFSET ?;";
            var args = [pointer.limit, pointer.offset];
        } else {
            var sql = "SELECT k.key_name, k.key_json, GROUP_CONCAT(zoom_level||'/'||tile_column ||'/'||tile_row,',') AS zxy FROM keymap k JOIN grid_key g ON k.key_name = g.key_name JOIN map m ON g.grid_id = m.grid_id WHERE m.zoom_level=? GROUP BY k.key_name LIMIT ? OFFSET ?;"
            var args = [info.maxzoom, pointer.limit, pointer.offset];
        }
        this._db.all(sql, args, function(err, rows) {
            if (err) return callback(err);
            var docs = rows.map(function(row) {
                var doc = {};
                doc.id = row.key_name;
                doc.doc = JSON.parse(row.key_json);
                // @TODO the doc field name for searching probably (?) belongs
                // in `metadata` and should be un-hardcoded in the future.
                doc.text = doc.doc.search || doc.doc.name || '';
                if (row.zxy) doc.zxy = tms2zxy(row.zxy);
                return doc;
            });
            pointer.offset += pointer.limit;
            return callback(null, docs, pointer);
        }.bind(this));
    }.bind(this));
};

// Adds carmen schema to startWriting.
MBTiles.prototype.startWriting = _(MBTiles.prototype.startWriting).wrap(function(parent, callback) {
    parent.call(this, function(err) {
        if (err) return callback(err);
        var sql = '\
        CREATE INDEX IF NOT EXISTS map_grid_id ON map (grid_id);\
        CREATE TABLE IF NOT EXISTS carmen_docs(shard INTEGER PRIMARY KEY, data BLOB);\
        CREATE TABLE IF NOT EXISTS carmen_freq(shard INTEGER PRIMARY KEY, data BLOB);\
        CREATE TABLE IF NOT EXISTS carmen_term(shard INTEGER PRIMARY KEY, data BLOB);\
        CREATE TABLE IF NOT EXISTS carmen_phrase(shard INTEGER PRIMARY KEY, data BLOB);';
        this._db.exec(sql, function(err) {
            if (err) {
                return callback(err);
            } else {
                return callback();
            }
        });
    }.bind(this));
});

