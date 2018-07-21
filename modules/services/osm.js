import _chunk from 'lodash-es/chunk';
import _cloneDeep from 'lodash-es/cloneDeep';
import _extend from 'lodash-es/extend';
import _forEach from 'lodash-es/forEach';
import _filter from 'lodash-es/filter';
import _find from 'lodash-es/find';
import _groupBy from 'lodash-es/groupBy';
import _isEmpty from 'lodash-es/isEmpty';
import _map from 'lodash-es/map';
import _throttle from 'lodash-es/throttle';
import _uniq from 'lodash-es/uniq';

import rbush from 'rbush';

import { dispatch as d3_dispatch } from 'd3-dispatch';
import { xml as d3_xml } from 'd3-request';

import osmAuth from 'osm-auth';
import { JXON } from '../util/jxon';
import { geoExtent, geoVecAdd } from '../geo';

import {
    osmEntity,
    osmNode,
    osmNote,
    osmRelation,
    osmWay
} from '../osm';

import {
    utilRebind,
    utilIdleWorker,
    utilTile,
    utilQsString
} from '../util';

var geoTile = utilTile();

var dispatch = d3_dispatch('authLoading', 'authDone', 'change', 'loading', 'loaded', 'loadedNotes');
var urlroot = 'https://www.openstreetmap.org';
var oauth = osmAuth({
    url: urlroot,
    oauth_consumer_key: '5A043yRSEugj4DJ5TljuapfnrflWDte8jTOcWLlT',
    oauth_secret: 'aB3jKq1TRsCOUrfOIZ6oQMEDmv2ptV76PA54NGLL',
    loading: authLoading,
    done: authDone
});

var _blacklists = ['.*\.google(apis)?\..*/(vt|kh)[\?/].*([xyz]=.*){3}.*'];
var _tileCache = { loaded: {}, inflight: {}, seen: {} };
var _noteCache = { loaded: {}, inflight: {}, inflightPost: {}, note: {}, rtree: rbush() };
var _userCache = { toLoad: {}, user: {} };
var _changeset = {};

var _connectionID = 1;
var _tileZoom = 16;
var _noteZoom = 12;
var _rateLimitError;
var _userChangesets;
var _userDetails;
var _off;


function authLoading() {
    dispatch.call('authLoading');
}


function authDone() {
    dispatch.call('authDone');
}


function abortRequest(i) {
    if (i) {
        i.abort();
    }
}


function getLoc(attrs) {
    var lon = attrs.lon && attrs.lon.value;
    var lat = attrs.lat && attrs.lat.value;
    return [parseFloat(lon), parseFloat(lat)];
}


function getNodes(obj) {
    var elems = obj.getElementsByTagName('nd');
    var nodes = new Array(elems.length);
    for (var i = 0, l = elems.length; i < l; i++) {
        nodes[i] = 'n' + elems[i].attributes.ref.value;
    }
    return nodes;
}


function getTags(obj) {
    var elems = obj.getElementsByTagName('tag');
    var tags = {};
    for (var i = 0, l = elems.length; i < l; i++) {
        var attrs = elems[i].attributes;
        tags[attrs.k.value] = attrs.v.value;
    }

    return tags;
}


function getMembers(obj) {
    var elems = obj.getElementsByTagName('member');
    var members = new Array(elems.length);
    for (var i = 0, l = elems.length; i < l; i++) {
        var attrs = elems[i].attributes;
        members[i] = {
            id: attrs.type.value[0] + attrs.ref.value,
            type: attrs.type.value,
            role: attrs.role.value
        };
    }
    return members;
}


function getVisible(attrs) {
    return (!attrs.visible || attrs.visible.value !== 'false');
}


function parseComments(comments) {
    var parsedComments = [];

    // for each comment
    for (var i = 0; i < comments.length; i++) {
        var comment = comments[i];
        if (comment.nodeName === 'comment') {
            var childNodes = comment.childNodes;
            var parsedComment = {};

            for (var j = 0; j < childNodes.length; j++) {
                var node = childNodes[j];
                var nodeName = node.nodeName;
                if (nodeName === '#text') continue;
                parsedComment[nodeName] = node.textContent;

                if (nodeName === 'uid') {
                    var uid = node.textContent;
                    if (uid && !_userCache.user[uid]) {
                        _userCache.toLoad[uid] = true;
                    }
                }
            }

            if (parsedComment) {
                parsedComments.push(parsedComment);
            }
        }
    }
    return parsedComments;
}


var parsers = {
    node: function nodeData(obj, uid) {
        var attrs = obj.attributes;
        return new osmNode({
            id: uid,
            visible: getVisible(attrs),
            version: attrs.version.value,
            changeset: attrs.changeset && attrs.changeset.value,
            timestamp: attrs.timestamp && attrs.timestamp.value,
            user: attrs.user && attrs.user.value,
            uid: attrs.uid && attrs.uid.value,
            loc: getLoc(attrs),
            tags: getTags(obj)
        });
    },

    way: function wayData(obj, uid) {
        var attrs = obj.attributes;
        return new osmWay({
            id: uid,
            visible: getVisible(attrs),
            version: attrs.version.value,
            changeset: attrs.changeset && attrs.changeset.value,
            timestamp: attrs.timestamp && attrs.timestamp.value,
            user: attrs.user && attrs.user.value,
            uid: attrs.uid && attrs.uid.value,
            tags: getTags(obj),
            nodes: getNodes(obj),
        });
    },

    relation: function relationData(obj, uid) {
        var attrs = obj.attributes;
        return new osmRelation({
            id: uid,
            visible: getVisible(attrs),
            version: attrs.version.value,
            changeset: attrs.changeset && attrs.changeset.value,
            timestamp: attrs.timestamp && attrs.timestamp.value,
            user: attrs.user && attrs.user.value,
            uid: attrs.uid && attrs.uid.value,
            tags: getTags(obj),
            members: getMembers(obj)
        });
    },

    note: function parseNote(obj, uid) {
        var attrs = obj.attributes;
        var childNodes = obj.childNodes;
        var props = {};

        props.id = uid;
        props.loc = getLoc(attrs);

        // if notes are coincident, move them apart slightly
        var coincident = false;
        var epsilon = 0.00001;
        do {
            if (coincident) {
                props.loc = geoVecAdd(props.loc, [epsilon, epsilon]);
            }
            var bbox = geoExtent(props.loc).bbox();
            coincident = _noteCache.rtree.search(bbox).length;
        } while (coincident);

        // parse note contents
        for (var i = 0; i < childNodes.length; i++) {
            var node = childNodes[i];
            var nodeName = node.nodeName;
            if (nodeName === '#text') continue;

            // if the element is comments, parse the comments
            if (nodeName === 'comments') {
                props[nodeName] = parseComments(node.childNodes);
            } else {
                props[nodeName] = node.textContent;
            }
        }

        var note = new osmNote(props);
        var item = { minX: note.loc[0], minY: note.loc[1], maxX: note.loc[0], maxY: note.loc[1], data: note };
        _noteCache.rtree.insert(item);
        _noteCache.note[note.id] = note;
        return note;
    },

    user: function parseUser(obj, uid) {
        var attrs = obj.attributes;
        var user = {
            id: uid,
            display_name: attrs.display_name && attrs.display_name.value,
            account_created: attrs.account_created && attrs.account_created.value,
            changesets_count: 0
        };

        var img = obj.getElementsByTagName('img');
        if (img && img[0] && img[0].getAttribute('href')) {
            user.image_url = img[0].getAttribute('href');
        }

        var changesets = obj.getElementsByTagName('changesets');
        if (changesets && changesets[0] && changesets[0].getAttribute('count')) {
            user.changesets_count = changesets[0].getAttribute('count');
        }

        _userCache.user[uid] = user;
        delete _userCache.toLoad[uid];
        return user;
    }
};


function parseXML(xml, callback, options) {
    options = _extend({ skipSeen: true }, options);
    if (!xml || !xml.childNodes) {
        return callback({ message: 'No XML', status: -1 });
    }

    var root = xml.childNodes[0];
    var children = root.childNodes;
    utilIdleWorker(children, parseChild, done);


    function done(results) {
        callback(null, results);
    }

    function parseChild(child) {
        var parser = parsers[child.nodeName];
        if (!parser) return null;

        var uid;
        if (child.nodeName === 'user') {
            uid = child.attributes.id.value;
            if (options.skipSeen && _userCache.user[uid]) {
                delete _userCache.toLoad[uid];
                return null;
            }

        } else if (child.nodeName === 'note') {
            uid = child.getElementsByTagName('id')[0].textContent;

        } else {
            uid = osmEntity.id.fromOSM(child.nodeName, child.attributes.id.value);
            if (options.skipSeen) {
                if (_tileCache.seen[uid]) return null;  // avoid reparsing a "seen" entity
                _tileCache.seen[uid] = true;
            }
        }

        return parser(child, uid);
    }
}


function wrapcb(thisArg, callback, cid) {
    return function(err, result) {
        if (err) {
            // 400 Bad Request, 401 Unauthorized, 403 Forbidden..
            if (err.status === 400 || err.status === 401 || err.status === 403) {
                thisArg.logout();
            }
            return callback.call(thisArg, err);

        } else if (thisArg.getConnectionId() !== cid) {
            return callback.call(thisArg, { message: 'Connection Switched', status: -1 });

        } else {
            return callback.call(thisArg, err, result);
        }
    };
}


export default {

    init: function() {
        utilRebind(this, dispatch, 'on');
    },


    reset: function() {
        _connectionID++;
        _userChangesets = undefined;
        _userDetails = undefined;
        _rateLimitError = undefined;

        _forEach(_tileCache.inflight, abortRequest);
        _forEach(_noteCache.inflight, abortRequest);
        _forEach(_noteCache.inflightPost, abortRequest);
        if (_changeset.inflight) abortRequest(_changeset.inflight);

        _tileCache = { loaded: {}, inflight: {}, seen: {} };
        _noteCache = { loaded: {}, inflight: {}, inflightPost: {}, note: {}, rtree: rbush() };
        _userCache = { toLoad: {}, user: {} };
        _changeset = {};

        return this;
    },


    getConnectionId: function() {
        return _connectionID;
    },


    changesetURL: function(changesetID) {
        return urlroot + '/changeset/' + changesetID;
    },


    changesetsURL: function(center, zoom) {
        var precision = Math.max(0, Math.ceil(Math.log(zoom) / Math.LN2));
        return urlroot + '/history#map=' +
            Math.floor(zoom) + '/' +
            center[1].toFixed(precision) + '/' +
            center[0].toFixed(precision);
    },


    entityURL: function(entity) {
        return urlroot + '/' + entity.type + '/' + entity.osmId();
    },


    historyURL: function(entity) {
        return urlroot + '/' + entity.type + '/' + entity.osmId() + '/history';
    },


    userURL: function(username) {
        return urlroot + '/user/' + username;
    },


    noteURL: function(note) {
        return urlroot + '/note/' + note.id;
    },


    // Generic method to load data from the OSM API
    // Can handle either auth or unauth calls.
    loadFromAPI: function(path, callback, options) {
        options = _extend({ skipSeen: true }, options);
        var that = this;
        var cid = _connectionID;

        function done(err, xml) {
            if (that.getConnectionId() !== cid) {
                if (callback) callback({ message: 'Connection Switched', status: -1 });
                return;
            }

            var isAuthenticated = that.authenticated();

            // 400 Bad Request, 401 Unauthorized, 403 Forbidden
            // Logout and retry the request..
            if (isAuthenticated && err && (err.status === 400 || err.status === 401 || err.status === 403)) {
                that.logout();
                that.loadFromAPI(path, callback, options);

            // else, no retry..
            } else {
                // 509 Bandwidth Limit Exceeded, 429 Too Many Requests
                // Set the rateLimitError flag and trigger a warning..
                if (!isAuthenticated && !_rateLimitError && err &&
                        (err.status === 509 || err.status === 429)) {
                    _rateLimitError = err;
                    dispatch.call('change');
                }

                if (callback) {
                    if (err) {
                        return callback(err);
                    } else {
                        return parseXML(xml, callback, options);
                    }
                }
            }
        }

        if (this.authenticated()) {
            return oauth.xhr({ method: 'GET', path: path }, done);
        } else {
            var url = urlroot + path;
            return d3_xml(url).get(done);
        }
    },


    // Load a single entity by id (ways and relations use the `/full` call)
    // GET /api/0.6/node/#id
    // GET /api/0.6/[way|relation]/#id/full
    loadEntity: function(id, callback) {
        var type = osmEntity.id.type(id);
        var osmID = osmEntity.id.toOSM(id);
        var options = { skipSeen: false };

        this.loadFromAPI(
            '/api/0.6/' + type + '/' + osmID + (type !== 'node' ? '/full' : ''),
            function(err, entities) {
                if (callback) callback(err, { data: entities });
            },
            options
        );
    },


    // Load a single entity with a specific version
    // GET /api/0.6/[node|way|relation]/#id/#version
    loadEntityVersion: function(id, version, callback) {
        var type = osmEntity.id.type(id);
        var osmID = osmEntity.id.toOSM(id);
        var options = { skipSeen: false };

        this.loadFromAPI(
            '/api/0.6/' + type + '/' + osmID + '/' + version,
            function(err, entities) {
                if (callback) callback(err, { data: entities });
            },
            options
        );
    },


    // Load multiple entities in chunks
    // (note: callback may be called multiple times)
    // GET /api/0.6/[nodes|ways|relations]?#parameters
    loadMultiple: function(ids, callback) {
        var that = this;

        _forEach(_groupBy(_uniq(ids), osmEntity.id.type), function(v, k) {
            var type = k + 's';
            var osmIDs = _map(v, osmEntity.id.toOSM);
            var options = { skipSeen: false };

            _forEach(_chunk(osmIDs, 150), function(arr) {
                that.loadFromAPI(
                    '/api/0.6/' + type + '?' + type + '=' + arr.join(),
                    function(err, entities) {
                        if (callback) callback(err, { data: entities });
                    },
                    options
                );
            });
        });
    },


    // Create, upload, and close a changeset
    // PUT /api/0.6/changeset/create
    // POST /api/0.6/changeset/#id/upload
    // PUT /api/0.6/changeset/#id/close
    putChangeset: function(changeset, changes, callback) {
        var cid = _connectionID;

        if (_changeset.inflight) {
            return callback({ message: 'Changeset already inflight', status: -2 }, changeset);

        } else if (_changeset.open) {   // reuse existing open changeset..
            return createdChangeset(null, _changeset.open);

        } else {   // Open a new changeset..
            var options = {
                method: 'PUT',
                path: '/api/0.6/changeset/create',
                options: { header: { 'Content-Type': 'text/xml' } },
                content: JXON.stringify(changeset.asJXON())
            };
            _changeset.inflight = oauth.xhr(
                options,
                wrapcb(this, createdChangeset, cid)
            );
        }


        function createdChangeset(err, changesetID) {
            _changeset.inflight = null;
            if (err) { return callback(err, changeset); }

            _changeset.open = changesetID;
            changeset = changeset.update({ id: changesetID });

            // Upload the changeset..
            var options = {
                method: 'POST',
                path: '/api/0.6/changeset/' + changesetID + '/upload',
                options: { header: { 'Content-Type': 'text/xml' } },
                content: JXON.stringify(changeset.osmChangeJXON(changes))
            };
            _changeset.inflight = oauth.xhr(
                options,
                wrapcb(this, uploadedChangeset, cid)
            );
        }


        function uploadedChangeset(err) {
            _changeset.inflight = null;
            if (err) return callback(err, changeset);

            // Upload was successful, safe to call the callback.
            // Add delay to allow for postgres replication #1646 #2678
            window.setTimeout(function() { callback(null, changeset); }, 2500);
            _changeset.open = null;

            // At this point, we don't really care if the connection was switched..
            // Only try to close the changeset if we're still talking to the same server.
            if (this.getConnectionId() === cid) {
                // Still attempt to close changeset, but ignore response because #2667
                oauth.xhr({
                    method: 'PUT',
                    path: '/api/0.6/changeset/' + changeset.id + '/close',
                    options: { header: { 'Content-Type': 'text/xml' } }
                }, function() { return true; });
            }
        }
    },


    // Load multiple users in chunks
    // (note: callback may be called multiple times)
    // GET /api/0.6/users?users=#id1,#id2,...,#idn
    loadUsers: function(uids, callback) {
        var toLoad = [];
        var cached = [];

        _uniq(uids).forEach(function(uid) {
            if (_userCache.user[uid]) {
                delete _userCache.toLoad[uid];
                cached.push(_userCache.user[uid]);
            } else {
                toLoad.push(uid);
            }
        });

        if (cached.length || !this.authenticated()) {
            callback(undefined, cached);
            if (!this.authenticated()) return;  // require auth
        }

        _chunk(toLoad, 150).forEach(function(arr) {
            oauth.xhr(
                { method: 'GET', path: '/api/0.6/users?users=' + arr.join() },
                wrapcb(this, done, _connectionID)
            );
        }.bind(this));

        function done(err, xml) {
            if (err) { return callback(err); }

            var options = { skipSeen: true };
            return parseXML(xml, function(err, results) {
                if (err) {
                    return callback(err);
                } else {
                    return callback(undefined, results);
                }
            }, options);
        }
    },


    // Load a given user by id
    // GET /api/0.6/user/#id
    loadUser: function(uid, callback) {
        if (_userCache.user[uid] || !this.authenticated()) {   // require auth
            delete _userCache.toLoad[uid];
            return callback(undefined, _userCache.user[uid]);
        }

        oauth.xhr(
            { method: 'GET', path: '/api/0.6/user/' + uid },
            wrapcb(this, done, _connectionID)
        );

        function done(err, xml) {
            if (err) { return callback(err); }

            var options = { skipSeen: true };
            return parseXML(xml, function(err, results) {
                if (err) {
                    return callback(err);
                } else {
                    return callback(undefined, results[0]);
                }
            }, options);
        }
    },


    // Load the details of the logged-in user
    // GET /api/0.6/user/details
    userDetails: function(callback) {
        if (_userDetails) {    // retrieve cached
            return callback(undefined, _userDetails);
        }

        oauth.xhr(
            { method: 'GET', path: '/api/0.6/user/details' },
            wrapcb(this, done, _connectionID)
        );

        function done(err, xml) {
            if (err) { return callback(err); }

            var options = { skipSeen: false };
            return parseXML(xml, function(err, results) {
                if (err) {
                    return callback(err);
                } else {
                    _userDetails = results[0];
                    return callback(undefined, _userDetails);
                }
            }, options);
        }
    },


    // Load previous changesets for the logged in user
    // GET /api/0.6/changesets?user=#id
    userChangesets: function(callback) {
        if (_userChangesets) {    // retrieve cached
            return callback(undefined, _userChangesets);
        }

        this.userDetails(
            wrapcb(this, gotDetails, _connectionID)
        );


        function gotDetails(err, user) {
            if (err) { return callback(err); }

            oauth.xhr(
                { method: 'GET', path: '/api/0.6/changesets?user=' + user.id },
                wrapcb(this, done, _connectionID)
            );
        }

        function done(err, xml) {
            if (err) { return callback(err); }

            _userChangesets = Array.prototype.map.call(
                xml.getElementsByTagName('changeset'),
                function (changeset) { return { tags: getTags(changeset) }; }
            ).filter(function (changeset) {
                var comment = changeset.tags.comment;
                return comment && comment !== '';
            });

            return callback(undefined, _userChangesets);
        }
    },


    // Fetch the status of the OSM API
    // GET /api/capabilities
    status: function(callback) {
        d3_xml(urlroot + '/api/capabilities').get(
            wrapcb(this, done, _connectionID)
        );

        function done(err, xml) {
            if (err) { return callback(err); }

            // update blacklists
            var elements = xml.getElementsByTagName('blacklist');
            var regexes = [];
            for (var i = 0; i < elements.length; i++) {
                var regex = elements[i].getAttribute('regex');  // needs unencode?
                if (regex) {
                    regexes.push(regex);
                }
            }
            if (regexes.length) {
                _blacklists = regexes;
            }

            if (_rateLimitError) {
                return callback(_rateLimitError, 'rateLimited');
            } else {
                var apiStatus = xml.getElementsByTagName('status');
                var val = apiStatus[0].getAttribute('api');
                return callback(undefined, val);
            }
        }
    },


    // Load data (entities or notes) from the API in tiles
    // GET /api/0.6/map?bbox=
    // GET /api/0.6/notes?bbox=
    loadTiles: function(projection, dimensions, callback, noteOptions) {
        if (_off) return;

        var that = this;

        // are we loading entities or notes?
        var loadingNotes = (noteOptions !== undefined);
        var path, cache, tilezoom, throttleLoadUsers;

        if (loadingNotes) {
            noteOptions = _extend({ limit: 10000, closed: 7}, noteOptions);
            path = '/api/0.6/notes?limit=' + noteOptions.limit + '&closed=' + noteOptions.closed + '&bbox=';
            cache = _noteCache;
            tilezoom = _noteZoom;
            throttleLoadUsers = _throttle(function() {
                var uids = Object.keys(_userCache.toLoad);
                if (!uids.length) return;
                that.loadUsers(uids, function() {});  // eagerly load user details
            }, 750);
        } else {
            path = '/api/0.6/map?bbox=';
            cache = _tileCache;
            tilezoom = _tileZoom;
        }

        // get tiles
        var tiles = geoTile.getTiles(projection, dimensions, tilezoom, 0);

        // remove inflight requests that no longer cover the view..
        var hadRequests = !_isEmpty(cache.inflight);
        geoTile.removeInflightRequests(cache, tiles, abortRequest);
        if (hadRequests && !loadingNotes && _isEmpty(cache.inflight)) {
            dispatch.call('loaded');    // stop the spinner
        }

        // issue new requests..
        tiles.forEach(function(tile) {
            if (cache.loaded[tile.id] || cache.inflight[tile.id]) return;
            if (!loadingNotes && _isEmpty(cache.inflight)) {
                dispatch.call('loading');   // start the spinner
            }

            var options = { skipSeen: !loadingNotes };
            cache.inflight[tile.id] = that.loadFromAPI(
                path + tile.extent.toParam(),
                function(err, parsed) {
                    delete cache.inflight[tile.id];
                    if (!err) {
                        cache.loaded[tile.id] = true;
                    }

                    if (loadingNotes) {
                        throttleLoadUsers();
                        dispatch.call('loadedNotes');

                    } else {
                        if (callback) {
                            callback(err, _extend({ data: parsed }, tile));
                        }
                        if (_isEmpty(cache.inflight)) {
                            dispatch.call('loaded');     // stop the spinner
                        }
                    }
                },
                options
            );
        });
    },


    // Load notes from the API (just calls this.loadTiles)
    // GET /api/0.6/notes?bbox=
    loadNotes: function(projection, dimensions, noteOptions) {
        noteOptions = _extend({ limit: 10000, closed: 7}, noteOptions);
        this.loadTiles(projection, dimensions, null, noteOptions);
    },


    // Create a note
    // POST /api/0.6/notes?params
    postNoteCreate: function(note, callback) {
        // todo
    },


    // Update a note
    // POST /api/0.6/notes/#id/comment?text=comment
    // POST /api/0.6/notes/#id/close?text=comment
    // POST /api/0.6/notes/#id/reopen?text=comment
    postNoteUpdate: function(note, newStatus, callback) {
        if (!this.authenticated()) {
            return callback({ message: 'Not Authenticated', status: -3 }, note);
        }
        if (_noteCache.inflightPost[note.id]) {
            return callback({ message: 'Note update already inflight', status: -2 }, note);
        }

        var action;
        if (note.status !== 'closed' && newStatus === 'closed') {
            action = 'close';
        } else if (note.status !== 'open' && newStatus === 'open') {
            action = 'reopen';
        } else {
            action = 'comment';
        }

        var path = '/api/0.6/notes/' + note.id + '/' + action;
        if (note.newComment) {
            path += '?' + utilQsString({ text: note.newComment });
        }

        _noteCache.inflightPost[note.id] = oauth.xhr(
            { method: 'POST', path: path },
            wrapcb(this, done, _connectionID)
        );


        function done(err, xml) {
            delete _noteCache.inflightPost[note.id];
            if (err) { return callback(err); }

            // we get the updated note back, remove from caches and reparse..
            var item = { minX: note.loc[0], minY: note.loc[1], maxX: note.loc[0], maxY: note.loc[1], data: note };
            _noteCache.rtree.remove(item, function isEql(a, b) { return a.data.id === b.data.id; });
            delete _noteCache.note[note.id];

            var options = { skipSeen: false };
            return parseXML(xml, function(err, results) {
                if (err) {
                    return callback(err);
                } else {
                    return callback(undefined, results[0]);
                }
            }, options);
        }
    },


    switch: function(options) {
        urlroot = options.urlroot;

        oauth.options(_extend({
            url: urlroot,
            loading: authLoading,
            done: authDone
        }, options));

        this.reset();
        this.userChangesets(function() {});  // eagerly load user details/changesets
        dispatch.call('change');
        return this;
    },


    toggle: function(_) {
        _off = !_;
        return this;
    },


    // get/set cached data
    // This is used to save/restore the state when entering/exiting the walkthrough
    // Also used for testing purposes.
    caches: function(obj) {
        if (!arguments.length) {
            return {
                tile: _cloneDeep(_tileCache),
                note: _cloneDeep(_noteCache),
                user: _cloneDeep(_userCache)
            };
        }

        // access caches directly for testing (e.g., loading notes rtree)
        if (obj === 'get') {
            return {
                tile: _tileCache,
                note: _noteCache,
                user: _userCache
            };
        }

        if (obj.tile) {
            _tileCache = obj.tile;
            _tileCache.inflight = {};
        }
        if (obj.note) {
            _noteCache = obj.note;
            _noteCache.inflight = {};
            _noteCache.inflightPost = {};
        }
        if (obj.user) {
            _userCache = obj.user;
        }

        return this;
    },


    logout: function() {
        _userChangesets = undefined;
        _userDetails = undefined;
        oauth.logout();
        dispatch.call('change');
        return this;
    },


    authenticated: function() {
        return oauth.authenticated();
    },


    authenticate: function(callback) {
        var that = this;
        var cid = _connectionID;
        _userChangesets = undefined;
        _userDetails = undefined;

        function done(err, res) {
            if (err) {
                if (callback) callback(err);
                return;
            }
            if (that.getConnectionId() !== cid) {
                if (callback) callback({ message: 'Connection Switched', status: -1 });
                return;
            }
            _rateLimitError = undefined;
            dispatch.call('change');
            if (callback) callback(err, res);
            that.userChangesets(function() {});  // eagerly load user details/changesets
        }

        return oauth.authenticate(done);
    },


    imageryBlacklists: function() {
        return _blacklists;
    },


    tileZoom: function(_) {
        if (!arguments.length) return _tileZoom;
        _tileZoom = _;
        return this;
    },


    // get all cached notes covering the viewport
    notes: function(projection) {
        var viewport = projection.clipExtent();
        var min = [viewport[0][0], viewport[1][1]];
        var max = [viewport[1][0], viewport[0][1]];
        var bbox = geoExtent(projection.invert(min), projection.invert(max)).bbox();

        return _noteCache.rtree.search(bbox)
            .map(function(d) { return d.data; });
    },


    // get a single note from the cache
    getNote: function(id) {
        return _noteCache.note[id];
    },


    // replace a single note in the cache
    replaceNote: function(n) {
        if (n instanceof osmNote) {
            _noteCache.note[n.id] = n;
        }
        return n;
    }

};
