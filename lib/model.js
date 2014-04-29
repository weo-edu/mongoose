/*!
 * Module dependencies.
 */

var Document = require('./document')
  , MongooseArray = require('./types/array')
  , MongooseError = require('./error')
  , VersionError = MongooseError.VersionError
  , DivergentArrayError = MongooseError.DivergentArrayError
  , Schema = require('./schema')
  , Types = require('./schema/index')
  , utils = require('./utils')
  , hasOwnProperty = utils.object.hasOwnProperty
  , isMongooseObject = utils.isMongooseObject
  , EventEmitter = require('events').EventEmitter
  , merge = utils.merge
  , Promise = require('./promise')
  , assert = require('assert')
  , util = require('util')
  , tick = utils.tick

var VERSION_WHERE = 1
  , VERSION_INC = 2
  , VERSION_ALL = VERSION_WHERE | VERSION_INC;

/**
 * Model constructor
 *
 * Provides the interface to MongoDB collections as well as creates document instances.
 *
 * @param {Object} doc values with which to create the document
 * @inherits Document
 * @event `error`: If listening to this event, it is emitted when a document was saved without passing a callback and an `error` occurred. If not listening, the event bubbles to the connection used to create this Model.
 * @event `index`: Emitted after `Model#ensureIndexes` completes. If an error occurred it is passed with the event.
 * @api public
 */

function Model (doc, fields, skipId) {
  Document.call(this, doc, fields, skipId);
};

/*!
 * Inherits from Document.
 *
 * All Model.prototype features are available on
 * top level (non-sub) documents.
 */

Model.prototype.__proto__ = Document.prototype;

/**
 * The name of the model
 *
 * @api public
 * @property modelName
 */

Model.prototype.modelName;

/**
 * Produces a special query document of the modified properties used in updates.
 *
 * @api private
 * @method $__delta
 * @memberOf Model
 */

Model.prototype.$__delta = function () {
  var dirty = this.$__dirty();
  if (!dirty.length && VERSION_ALL != this.$__.version) return;

  var where = {}
    , delta = {}
    , len = dirty.length
    , divergent = []
    , d = 0
    , val
    , obj

  for (; d < len; ++d) {
    var data = dirty[d]
    var value = data.value
    var schema = data.schema

    var match = checkDivergentArray(this, data.path, value);
    if (match) {
      divergent.push(match);
      continue;
    }

    if (divergent.length) continue;

    if (undefined === value) {
      operand(this, where, delta, data, 1, '$unset');

    } else if (null === value) {
      operand(this, where, delta, data, null);

    } else if (value._path && value._atomics) {
      // arrays and other custom types (support plugins etc)
      handleAtomics(this, where, delta, data, value);

    } else if (value._path && Buffer.isBuffer(value)) {
      // MongooseBuffer
      value = value.toObject();
      operand(this, where, delta, data, value);

    } else {
      value = utils.clone(value, { depopulate: 1 });
      operand(this, where, delta, data, value);
    }
  }

  if (divergent.length) {
    return new DivergentArrayError(divergent);
  }

  if (this.$__.version) {
    this.$__version(where, delta);
  }

  return [where, delta];
}

/*!
 * Determine if array was populated with some form of filter and is now
 * being updated in a manner which could overwrite data unintentionally.
 *
 * @see https://github.com/LearnBoost/mongoose/issues/1334
 * @param {Document} doc
 * @param {String} path
 * @return {String|undefined}
 */

function checkDivergentArray (doc, path, array) {
  // see if we populated this path
  var pop = doc.populated(path, true);

  if (!pop && doc.$__.selected) {
    // If any array was selected using an $elemMatch projection, we deny the update.
    // NOTE: MongoDB only supports projected $elemMatch on top level array.
    var top = path.split('.')[0];
    if (doc.$__.selected[top] && doc.$__.selected[top].$elemMatch) {
      return top;
    }
  }

  if (!(pop && array instanceof MongooseArray)) return;

  // If the array was populated using options that prevented all
  // documents from being returned (match, skip, limit) or they
  // deselected the _id field, $pop and $set of the array are
  // not safe operations. If _id was deselected, we do not know
  // how to remove elements. $pop will pop off the _id from the end
  // of the array in the db which is not guaranteed to be the
  // same as the last element we have here. $set of the entire array
  // would be similarily destructive as we never received all
  // elements of the array and potentially would overwrite data.
  var check = pop.options.match ||
              pop.options.options && hasOwnProperty(pop.options.options, 'limit') || // 0 is not permitted
              pop.options.options && pop.options.options.skip || // 0 is permitted
              pop.options.select && // deselected _id?
                (0 === pop.options.select._id ||
                /\s?-_id\s?/.test(pop.options.select))

  if (check) {
    var atomics = array._atomics;
    if (0 === Object.keys(atomics).length || atomics.$set || atomics.$pop) {
      return path;
    }
  }
}

/**
 * Appends versioning to the where and update clauses.
 *
 * @api private
 * @method $__version
 * @memberOf Model
 */

Model.prototype.$__version = function (where, delta) {
  var key = this.schema.options.versionKey;

  if (true === where) {
    // this is an insert
    if (key) this.setValue(key, delta[key] = 0);
    return;
  }

  // updates

  // only apply versioning if our versionKey was selected. else
  // there is no way to select the correct version. we could fail
  // fast here and force them to include the versionKey but
  // thats a bit intrusive. can we do this automatically?
  if (!this.isSelected(key)) {
    return;
  }

  // $push $addToSet don't need the where clause set
  if (VERSION_WHERE === (VERSION_WHERE & this.$__.version)) {
    where[key] = this.getValue(key);
  }

  if (VERSION_INC === (VERSION_INC & this.$__.version)) {
    delta.$inc || (delta.$inc = {});
    delta.$inc[key] = 1;
  }
}

/**
 * Signal that we desire an increment of this documents version.
 *
 * ####Example:
 *
 *     Model.findById(id, function (err, doc) {
 *       doc.increment();
 *       doc.save(function (err) { .. })
 *     })
 *
 * @see versionKeys http://mongoosejs.com/docs/guide.html#versionKey
 * @api public
 */

Model.prototype.increment = function increment () {
  this.$__.version = VERSION_ALL;
  return this;
}


/**
 * Returns another Model instance.
 *
 * ####Example:
 *
 *     var doc = new Tank;
 *     doc.model('User').findById(id, callback);
 *
 * @param {String} name model name
 * @api public
 */

Model.prototype.model = function model (name) {
  return require('./index').model(name);
};

/**
 * Adds a discriminator type.
 *
 * ####Example:
 *
 *     function BaseSchema() {
 *       Schema.apply(this, arguments);
 *
 *       this.add({
 *         name: String,
 *         createdAt: Date
 *       });
 *     }
 *     util.inherits(BaseSchema, Schema);
 *
 *     var PersonSchema = new BaseSchema();
 *     var BossSchema = new BaseSchema({ department: String });
 *
 *     var Person = mongoose.model('Person', PersonSchema);
 *     var Boss = Person.discriminator('Boss', BossSchema);
 *
 * @param {String} name   discriminator model name
 * @param {Schema} schema discriminator model schema
 * @api public
 */

Model.discriminator = function discriminator (name, schema) {
  if (!(schema instanceof Schema)) {
    throw new Error("You must pass a valid discriminator Schema");
  }

  if (this.schema.discriminatorMapping && !this.schema.discriminatorMapping.isRoot) {
    throw new Error("Discriminator \"" + name + "\" can only be a discriminator of the root model");
  }

  var key = this.schema.options.discriminatorKey;
  if (schema.path(key)) {
    throw new Error("Discriminator \"" + name + "\" cannot have field with name \"" + key + "\"");
  }

  // merges base schema into new discriminator schema and sets new type field.
  (function mergeSchemas(schema, baseSchema) {
    utils.merge(schema, baseSchema);

    var obj = {};
    obj[key] = { type: String, default: name };
    schema.add(obj);
    schema.discriminatorMapping = { key: key, value: name, isRoot: false };

    // throws error if options are invalid
    (function validateOptions(a, b) {
      a = utils.clone(a);
      b = utils.clone(b);
      delete a.toJSON;
      delete a.toObject;
      delete b.toJSON;
      delete b.toObject;

      if (!utils.deepEqual(a, b)) {
        throw new Error("Discriminator options are not customizable (except toJSON & toObject)");
      }
    })(schema.options, baseSchema.options);

    var toJSON = schema.options.toJSON
      , toObject = schema.options.toObject;

    schema.options = utils.clone(baseSchema.options);
    if (toJSON)   schema.options.toJSON = toJSON;
    if (toObject) schema.options.toObject = toObject;

    schema.callQueue = baseSchema.callQueue.concat(schema.callQueue);
    schema._requiredpaths = undefined; // reset just in case Schema#requiredPaths() was called on either schema
  })(schema, this.schema);

  if (!this.discriminators) {
    this.discriminators = {};
  }

  if (!this.schema.discriminatorMapping) {
    this.schema.discriminatorMapping = { key: key, value: null, isRoot: true };
  }

  if (this.discriminators[name]) {
    throw new Error("Discriminator with name \"" + name + "\" already exists");
  }

  this.discriminators[name] = require('./index').model(name, schema);
  this.discriminators[name].prototype.__proto__ = this.prototype;

  return this.discriminators[name];
};

// Model (class) features

/*!
 * Give the constructor the ability to emit events.
 */

for (var i in EventEmitter.prototype)
  Model[i] = EventEmitter.prototype[i];

/**
 * Called when the model compiles.
 *
 * @api private
 */

Model.init = function init () {
  this.schema.emit('init', this);
};

/**
 * Schema the model uses.
 *
 * @property schema
 * @receiver Model
 * @api public
 */

Model.schema;

/**
 * Base Mongoose instance the model uses.
 *
 * @property base
 * @receiver Model
 * @api public
 */

Model.base;

/**
 * Registered discriminators for this model.
 *
 * @property discriminators
 * @receiver Model
 * @api public
 */

Model.discriminators;

/**
 * Shortcut for creating a new Document that is automatically saved to the db if valid.
 *
 * ####Example:
 *
 *     // pass individual docs
 *     Candy.create({ type: 'jelly bean' }, { type: 'snickers' }, function (err, jellybean, snickers) {
 *       if (err) // ...
 *     });
 *
 *     // pass an array
 *     var array = [{ type: 'jelly bean' }, { type: 'snickers' }];
 *     Candy.create(array, function (err, jellybean, snickers) {
 *       if (err) // ...
 *     });
 *
 *     // callback is optional; use the returned promise if you like:
 *     var promise = Candy.create({ type: 'jawbreaker' });
 *     promise.then(function (jawbreaker) {
 *       // ...
 *     })
 *
 * @param {Array|Object...} doc(s)
 * @param {Function} [fn] callback
 * @return {Promise}
 * @api public
 */

Model.create = function create (doc, fn) {
  var promise = new Promise
    , args

  if (Array.isArray(doc)) {
    args = doc;

    if ('function' == typeof fn) {
      promise.onResolve(fn);
    }

  } else {
    var last  = arguments[arguments.length - 1];

    if ('function' == typeof last) {
      promise.onResolve(last);
      args = utils.args(arguments, 0, arguments.length - 1);
    } else {
      args = utils.args(arguments);
    }
  }

  var count = args.length;

  if (0 === count) {
    promise.complete();
    return promise;
  }

  var self = this;
  var docs = [];

  args.forEach(function (arg, i) {
    var doc = new self(arg);
    docs[i] = doc;
    doc.save(function (err) {
      if (err) return promise.error(err);
      --count || promise.complete.apply(promise, docs);
    });
  });

  return promise;
};

/*!
 * Retrieve the _id of `val` if a Document or Array of Documents.
 *
 * @param {Array|Document|Any} val
 * @return {Array|Document|Any}
 */

function convertTo_id (val) {
  if (val instanceof Model) return val._id;

  if (Array.isArray(val)) {
    for (var i = 0; i < val.length; ++i) {
      if (val[i] instanceof Model) {
        val[i] = val[i]._id;
      }
    }
    return val;
  }

  return val;
}

/*!
 * Assigns documents returned from a population query back
 * to the original document path.
 */

function assignVals (o) {
  // replace the original ids in our intermediate _ids structure
  // with the documents found by query

  assignRawDocsToIdStructure(o.rawIds, o.rawDocs, o.rawOrder, o.options);

  // now update the original documents being populated using the
  // result structure that contains real documents.

  var docs = o.docs;
  var path = o.path;
  var rawIds = o.rawIds;
  var options = o.options;

  for (var i = 0; i < docs.length; ++i) {
    utils.setValue(path, rawIds[i], docs[i], function (val) {
      return valueFilter(val, options);
    });
  }
}

/*!
 * 1) Apply backwards compatible find/findOne behavior to sub documents
 *
 *    find logic:
 *      a) filter out non-documents
 *      b) remove _id from sub docs when user specified
 *
 *    findOne
 *      a) if no doc found, set to null
 *      b) remove _id from sub docs when user specified
 *
 * 2) Remove _ids when specified by users query.
 *
 * background:
 * _ids are left in the query even when user excludes them so
 * that population mapping can occur.
 */

function valueFilter (val, assignmentOpts) {
  if (Array.isArray(val)) {
    // find logic
    var ret = [];
    for (var i = 0; i < val.length; ++i) {
      var subdoc = val[i];
      if (!isDoc(subdoc)) continue;
      maybeRemoveId(subdoc, assignmentOpts);
      ret.push(subdoc);
    }
    return ret;
  }

  // findOne
  if (isDoc(val)) {
    maybeRemoveId(val, assignmentOpts);
    return val;
  }

  return null;
}

/*!
 * Remove _id from `subdoc` if user specified "lean" query option
 */

function maybeRemoveId (subdoc, assignmentOpts) {
  if (assignmentOpts.excludeId) {
    if ('function' == typeof subdoc.setValue) {
      subdoc.setValue('_id', undefined);
    } else {
      delete subdoc._id;
    }
  }
}

/*!
 * Determine if `doc` is a document returned
 * by a populate query.
 */

function isDoc (doc) {
  if (null == doc)
    return false;

  var type = typeof doc;
  if ('string' == type)
    return false;

  if ('number' == type)
    return false;

  if (Buffer.isBuffer(doc))
    return false;

  if ('ObjectID' == doc.constructor.name)
    return false;

  // only docs
  return true;
}

/*!
 * Assign `vals` returned by mongo query to the `rawIds`
 * structure returned from utils.getVals() honoring
 * query sort order if specified by user.
 *
 * This can be optimized.
 *
 * Rules:
 *
 *   if the value of the path is not an array, use findOne rules, else find.
 *   for findOne the results are assigned directly to doc path (including null results).
 *   for find, if user specified sort order, results are assigned directly
 *   else documents are put back in original order of array if found in results
 *
 * @param {Array} rawIds
 * @param {Array} vals
 * @param {Boolean} sort
 * @api private
 */

function assignRawDocsToIdStructure (rawIds, resultDocs, resultOrder, options, recursed) {
  // honor user specified sort order
  var newOrder = [];
  var sorting = options.sort && rawIds.length > 1;
  var found;
  var doc;
  var sid;
  var id;

  for (var i = 0; i < rawIds.length; ++i) {
    id = rawIds[i];

    if (Array.isArray(id)) {
      // handle [ [id0, id2], [id3] ]
      assignRawDocsToIdStructure(id, resultDocs, resultOrder, options, true);
      newOrder.push(id);
      continue;
    }

    if (null === id && !sorting) {
      // keep nulls for findOne unless sorting, which always
      // removes them (backward compat)
      newOrder.push(id);
      continue;
    }

    sid = String(id);
    found = false;

    if (recursed) {
      // apply find behavior

      // assign matching documents in original order unless sorting
      doc = resultDocs[sid];
      if (doc) {
        if (sorting) {
          newOrder[resultOrder[sid]] = doc;
        } else {
          newOrder.push(doc);
        }
      } else {
        newOrder.push(id);
      }
    } else {
      // apply findOne behavior - if document in results, assign, else assign null
      newOrder[i] = doc = resultDocs[sid] || null;
    }
  }

  rawIds.length = 0;
  if (newOrder.length) {
    // reassign the documents based on corrected order

    // forEach skips over sparse entries in arrays so we
    // can safely use this to our advantage dealing with sorted
    // result sets too.
    newOrder.forEach(function (doc, i) {
      rawIds[i] = doc;
    });
  }
}

/**
 * Finds the schema for `path`. This is different than
 * calling `schema.path` as it also resolves paths with
 * positional selectors (something.$.another.$.path).
 *
 * @param {String} path
 * @return {Schema}
 * @api private
 */

Model._getSchema = function _getSchema (path) {
  var schema = this.schema
    , pathschema = schema.path(path);

  if (pathschema)
    return pathschema;

  // look for arrays
  return (function search (parts, schema) {
    var p = parts.length + 1
      , foundschema
      , trypath

    while (p--) {
      trypath = parts.slice(0, p).join('.');
      foundschema = schema.path(trypath);
      if (foundschema) {
        if (foundschema.caster) {

          // array of Mixed?
          if (foundschema.caster instanceof Types.Mixed) {
            return foundschema.caster;
          }

          // Now that we found the array, we need to check if there
          // are remaining document paths to look up for casting.
          // Also we need to handle array.$.path since schema.path
          // doesn't work for that.
          // If there is no foundschema.schema we are dealing with
          // a path like array.$
          if (p !== parts.length && foundschema.schema) {
            if ('$' === parts[p]) {
              // comments.$.comments.$.title
              return search(parts.slice(p+1), foundschema.schema);
            } else {
              // this is the last path of the selector
              return search(parts.slice(p), foundschema.schema);
            }
          }
        }
        return foundschema;
      }
    }
  })(path.split('.'), schema)
}

/*!
 * Compiler utility.
 *
 * @param {String} name model name
 * @param {Schema} schema
 * @param {Mongoose} base mongoose instance
 */

Model.compile = function compile (name, schema, base) {
  var versioningEnabled = false !== schema.options.versionKey;

  if (versioningEnabled && !schema.paths[schema.options.versionKey]) {
    // add versioning to top level documents only
    var o = {};
    o[schema.options.versionKey] = Number;
    schema.add(o);
  }

  // generate new class
  function model (doc, fields, skipId) {
    if (!(this instanceof model))
      return new model(doc, fields, skipId);
    Model.call(this, doc, fields, skipId);
  };

  model.base = base;
  model.modelName = name;
  model.__proto__ = Model;
  model.prototype.__proto__ = Model.prototype;
  model.model = Model.prototype.model;
  model.discriminators = model.prototype.discriminators = undefined;

  model.prototype.$__setSchema(schema);

  // apply methods
  for (var i in schema.methods)
    model.prototype[i] = schema.methods[i];

  // apply statics
  for (var i in schema.statics)
    model[i] = schema.statics[i];

  model.schema = model.prototype.schema;
  model.options = model.prototype.options;

  return model;
};

/*!
 * Subclass this model with `schema`, and settings.
 *
 * @param {Schema} [schema]
 * @return {Model}
 */

Model.__subclass = function subclass (schema) {
  var model = this;

  var Model = function Model (doc, fields, skipId) {
    if (!(this instanceof Model)) {
      return new Model(doc, fields, skipId);
    }
    model.call(this, doc, fields, skipId);
  }

  Model.__proto__ = model;
  Model.prototype.__proto__ = model.prototype;

  var s = schema && 'string' != typeof schema
    ? schema
    : model.prototype.schema;

  var options = s.options || {};

  Model.init();
  return Model;
}

/*!
 * Module exports.
 */

module.exports = exports = Model;
