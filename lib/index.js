'use strict';

/*!
 * Module dependencies.
 */

var Schema = require('./schema')
  , SchemaType = require('./schematype')
  , VirtualType = require('./virtualtype')
  , SchemaDefaults = require('./schemadefault')
  , Types = require('./types')
//  , Query = require('./query')
  , Promise = require('./promise')
  , Model = require('./model')
  , Document = require('./document')
  , utils = require('./utils')
  , format = utils.toCollectionName
  , pkg = require('../package.json')

/*!
 * Warn users if they are running an unstable release.
 *
 * Disable the warning by setting the MONGOOSE_DISABLE_STABILITY_WARNING
 * environment variable.
 */

if (pkg.publishConfig && 'unstable' == pkg.publishConfig.tag) {
  if (!process.env.MONGOOSE_DISABLE_STABILITY_WARNING) {
    console.log('\u001b[33m');
    console.log('##############################################################');
    console.log('#');
    console.log('#   !!! MONGOOSE WARNING !!!');
    console.log('#');
    console.log('#   This is an UNSTABLE release of Mongoose.');
    console.log('#   Unstable releases are available for preview/testing only.');
    console.log('#   DO NOT run this in production.');
    console.log('#');
    console.log('##############################################################');
    console.log('\u001b[0m');
  }
}

/**
 * Mongoose constructor.
 *
 * The exports object of the `mongoose` module is an instance of this class.
 * Most apps will only use this one instance.
 *
 * @api public
 */

function Mongoose () {
  this.plugins = [];
  this.models = {};
  this.modelSchemas = {};
  // default global options
  this.options = {
    pluralization: true
  };
};

/**
 * Sets mongoose options
 *
 * ####Example:
 *
 *     mongoose.set('test', value) // sets the 'test' option to `value`
 *
 *     mongoose.set('debug', true) // enable logging collection methods + arguments to the console
 *
 * @param {String} key
 * @param {String} value
 * @api public
 */

Mongoose.prototype.set = function (key, value) {
  if (arguments.length == 1) {
    return this.options[key];
  }

  this.options[key] = value;
  return this;
};

/**
 * Gets mongoose options
 *
 * ####Example:
 *
 *     mongoose.get('test') // returns the 'test' value
 *
 * @param {String} key
 * @method get
 * @api public
 */

Mongoose.prototype.get = Mongoose.prototype.set;

/**
 * Defines a model or retrieves it.
 *
 * Models defined on the `mongoose` instance are available to all connection created by the same `mongoose` instance.
 *
 * ####Example:
 *
 *     var mongoose = require('mongoose');
 *
 *     // define an Actor model with this mongoose instance
 *     mongoose.model('Actor', new Schema({ name: String }));
 *
 *     // create a new connection
 *     var conn = mongoose.createConnection(..);
 *
 *     // retrieve the Actor model
 *     var Actor = conn.model('Actor');
 *
 * _When no `collection` argument is passed, Mongoose produces a collection name by passing the model `name` to the [utils.toCollectionName](#utils_exports.toCollectionName) method. This method pluralizes the name. If you don't like this behavior, either pass a collection name or set your schemas collection name option._
 *
 * ####Example:
 *
 *     var schema = new Schema({ name: String }, { collection: 'actor' });
 *
 *     // or
 *
 *     schema.set('collection', 'actor');
 *
 *     // or
 *
 *     var collectionName = 'actor'
 *     var M = mongoose.model('Actor', schema, collectionName)
 *
 * @param {String} name model name
 * @param {Schema} [schema]
 * @param {String} [collection] name (optional, induced from model name)
 * @param {Boolean} [skipInit] whether to skip initialization (defaults to false)
 * @api public
 */

Mongoose.prototype.model = function (name, schema, collection, skipInit) {
  if ('string' == typeof schema) {
    collection = schema;
    schema = false;
  }

  if (utils.isObject(schema) && !(schema instanceof Schema)) {
    schema = new Schema(schema);
  }

  if ('boolean' === typeof collection) {
    skipInit = collection;
    collection = null;
  }

  // handle internal options from connection.model()
  var options;
  if (skipInit && utils.isObject(skipInit)) {
    options = skipInit;
    skipInit = true;
  } else {
    options = {};
  }

  // look up schema for the collection. this might be a
  // default schema like system.indexes stored in SchemaDefaults.
  if (!this.modelSchemas[name]) {
    if (!schema && name in SchemaDefaults) {
      schema = SchemaDefaults[name];
    }

    if (schema) {
      // cache it so we only apply plugins once
      this.modelSchemas[name] = schema;
      this._applyPlugins(schema);
    } else {
      throw new mongoose.Error.MissingSchemaError(name);
    }
  }

  var model;
  var sub;

  // connection.model() may be passing a different schema for
  // an existing model name. in this case don't read from cache.
  if (this.models[name] && false !== options.cache) {
    if (schema instanceof Schema && schema != this.models[name].schema) {
      throw new mongoose.Error.OverwriteModelError(name);
    }

    if (collection) {
      // subclass current model with alternate collection
      model = this.models[name];
      schema = model.prototype.schema;
      sub = model.__subclass(this.connection, schema, collection);
      // do not cache the sub model
      return sub;
    }

    return this.models[name];
  }

  // ensure a schema exists
  if (!schema) {
    schema = this.modelSchemas[name];
    if (!schema) {
      throw new mongoose.Error.MissingSchemaError(name);
    }
  }

  // Apply relevant "global" options to the schema
  if (!('pluralization' in schema.options)) schema.options.pluralization = this.options.pluralization;


  if (!collection) {
    collection = schema.get('collection') || format(name, schema.options);
  }

  var connection = options.connection || this.connection;
  model = Model.compile(name, schema, collection, connection, this);

  if (!skipInit) {
    model.init();
  }

  if (false === options.cache) {
    return model;
  }

  return this.models[name] = model;
}

/**
 * Returns an array of model names created on this instance of Mongoose.
 *
 * ####Note:
 *
 * _Does not include names of models created using `connection.model()`._
 *
 * @api public
 * @return {Array}
 */

Mongoose.prototype.modelNames = function () {
  var names = Object.keys(this.models);
  return names;
}

/**
 * Applies global plugins to `schema`.
 *
 * @param {Schema} schema
 * @api private
 */

Mongoose.prototype._applyPlugins = function (schema) {
  for (var i = 0, l = this.plugins.length; i < l; i++) {
    schema.plugin(this.plugins[i][0], this.plugins[i][1]);
  }
}

/**
 * Declares a global plugin executed on all Schemas.
 *
 * Equivalent to calling `.plugin(fn)` on each Schema you create.
 *
 * @param {Function} fn plugin callback
 * @param {Object} [opts] optional options
 * @return {Mongoose} this
 * @see plugins ./plugins.html
 * @api public
 */

Mongoose.prototype.plugin = function (fn, opts) {
  this.plugins.push([fn, opts]);
  return this;
};

/**
 * The Mongoose version
 *
 * @property version
 * @api public
 */

Mongoose.prototype.version = pkg.version;

/**
 * The Mongoose constructor
 *
 * The exports of the mongoose module is an instance of this class.
 *
 * ####Example:
 *
 *     var mongoose = require('mongoose');
 *     var mongoose2 = new mongoose.Mongoose();
 *
 * @method Mongoose
 * @api public
 */

Mongoose.prototype.Mongoose = Mongoose;

/**
 * The Mongoose [Schema](#schema_Schema) constructor
 *
 * ####Example:
 *
 *     var mongoose = require('mongoose');
 *     var Schema = mongoose.Schema;
 *     var CatSchema = new Schema(..);
 *
 * @method Schema
 * @api public
 */

Mongoose.prototype.Schema = Schema;

/**
 * The Mongoose [SchemaType](#schematype_SchemaType) constructor
 *
 * @method SchemaType
 * @api public
 */

Mongoose.prototype.SchemaType = SchemaType;

/**
 * The various Mongoose SchemaTypes.
 *
 * ####Note:
 *
 * _Alias of mongoose.Schema.Types for backwards compatibility._
 *
 * @property SchemaTypes
 * @see Schema.SchemaTypes #schema_Schema.Types
 * @api public
 */

Mongoose.prototype.SchemaTypes = Schema.Types;

/**
 * The Mongoose [VirtualType](#virtualtype_VirtualType) constructor
 *
 * @method VirtualType
 * @api public
 */

Mongoose.prototype.VirtualType = VirtualType;

/**
 * The various Mongoose Types.
 *
 * ####Example:
 *
 *     var mongoose = require('mongoose');
 *     var array = mongoose.Types.Array;
 *
 * ####Types:
 *
 * - [ObjectId](#types-objectid-js)
 * - [Buffer](#types-buffer-js)
 * - [SubDocument](#types-embedded-js)
 * - [Array](#types-array-js)
 * - [DocumentArray](#types-documentarray-js)
 *
 * Using this exposed access to the `ObjectId` type, we can construct ids on demand.
 *
 *     var ObjectId = mongoose.Types.ObjectId;
 *     var id1 = new ObjectId;
 *
 * @property Types
 * @api public
 */

Mongoose.prototype.Types = Types;

/**
 * The Mongoose [Query](#query_Query) constructor.
 *
 * @method Query
 * @api public
 */

//Mongoose.prototype.Query = Query;

/**
 * The Mongoose [Promise](#promise_Promise) constructor.
 *
 * @method Promise
 * @api public
 */

Mongoose.prototype.Promise = Promise;

/**
 * The Mongoose [Model](#model_Model) constructor.
 *
 * @method Model
 * @api public
 */

Mongoose.prototype.Model = Model;

/**
 * The Mongoose [Document](#document-js) constructor.
 *
 * @method Document
 * @api public
 */

Mongoose.prototype.Document = Document;

/**
 * The [MongooseError](#error_MongooseError) constructor.
 *
 * @method Error
 * @api public
 */

Mongoose.prototype.Error = require('./error');

/**
 * The [mquery](https://github.com/aheckmann/mquery) query builder Mongoose uses.
 *
 * @property mquery
 * @api public
 */

//Mongoose.prototype.mquery = require('mquery');

/*!
 * The exports object is an instance of Mongoose.
 *
 * @api public
 */

var mongoose = module.exports = exports = new Mongoose;
