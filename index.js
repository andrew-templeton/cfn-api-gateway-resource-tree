
var crypto = require('crypto');

var AWS = require('aws-sdk');
var CfnLambda = require('cfn-lambda');

var APIG = new AWS.APIGateway({apiVersion: '2015-07-09'});

exports.handler = CfnLambda({
  Create: Create,
  Update: Update,
  Delete: Delete,
  SchemaPath: [__dirname, 'schema.json']
});

function Upsert(cleanable, makeable, reply) {
  var idHash = {};
  console.log('Sanitizing old tree: %j', cleanable);
  cleanParent(cleanable.RestApiId, cleanable.ParentId,
    function(cleanErr, cleanedPath) {
      if (cleanErr) {
        console.log('Failed to clean ParentId %s, FAILURE: %j',
          cleanable.ParentId, cleanErr);
        return reply(cleanErr.message);
      }
      console.log('Finished cleaning %s, now creating tree: %j', cleanedPath, makeable);
      // Use root for building Relatives first, will map later to Absolute::
      constructLayer(makeable.ParentId, '', makeable.ChildResources,
        function(makeTreeErr, makeTreeSuccess) {
          if (makeTreeErr) {
            console.log('Failed to make tree, FAILURE: ', makeTreeErr);
            return reply(makeTreeErr.message);
          }
          console.log('Made tree, now building GetAtt hash: %j', makeTreeSuccess);
          console.log('Returning hash of GetAtt: %j', idHash);
          reply(null, getPhysicalId(makeable), idHash);
        });
    });

  function constructLayer(parentId, parentPath, children, completedLayer) {
    asyncMap(children.map(function(child) {
      var path = parentPath + '/' + child.PathPart;
      return function(completedChild) {
        makeResource(parentId, child.PathPart, function(err, childResult) {
          if (err) {
            console.log('Error making child %s: %j', path, err);
            return completedChild(err);
          }
          console.log('Constructed resource %s: %j', path, child);
          idHash[path] = childResult.id;
          if (!child.ChildResources) {
            return completedChild(null, childResult);
          }
          console.log('Child %s has children, constructing: %j', path, child.ChildResources);
          constructLayer(childResult.id, path, child.ChildResources, completedChild);
        });
      };
    }), function(layerErr, layerCompletion) {
      if (layerErr) {
        console.log('Layer construction error on %s: %j ',
          parentPath, children);
        return completedLayer(layerErr);
      }
      completedLayer(null, layerCompletion);
    });
  }

  function makeResource(parentId, pathPart, callback, delay) {
    APIG.createResource({
      restApiId: makeable.RestApiId,
      parentId: parentId,
      pathPart: pathPart
    }, function(err, data) {
      var retryDelay = delay || 250;
      if (err && err.statusCode === 429) {
        console.log('Getting throttled! Delaying by %s', retryDelay);
        return setTimeout(function() {
          makeResource(parentId, pathPart, callback, retryDelay * 2);
        }, retryDelay);
      }
      callback(err, data);
    });
  }
}



function Create(params, reply) {
  console.log('CREATE delegating to Upsert.');
  Upsert(params, params, reply);
}

function Update(physicalId, params, oldParams, reply) {
  console.log('UPDATE delegating to Upsert.');
  Upsert(oldParams, params, reply);
}

function Delete(physicalId, params, reply) {
  if (physicalId === getPhysicalId(params)) {
    console.log('Appears this is an UPDATE_CLEANUP, mismatched deletion signature.');
    console.log('Non-deleted stream table: %j', params);
    return reply();
  }
  cleanParent(params.RestApiId, params.ParentId, function(cleanErr, cleanedPath) {
    if (cleanErr && cleanErr.statusCode !== 404) {
      console.log('Failed to clean %s');
      return reply(cleanErr.message);
    }
    console.log('Deleted the subtree: %s', cleanedPath);
    reply();
  });
}

function getPhysicalId(params) {
  var shasum = crypto.createHash('sha256');
  shasum.update(JSON.stringify(params.ChildResources));
  return [
    params.RestApiId,
    params.ParentId,
    shasum.digest('hex')
  ].join('---');
}

function cleanParent(restApiId, parentResourceId, callback) {

  var pageSize = 500;
  var resources = [];
  collectResources();

  function collectResources(position) {
    console.log('Collecting resources on the API...');
    APIG.getResources({
      restApiId: restApiId,
      limit: pageSize,
      position: position
    }, function(err, data) {
      if (err) {
        console.error('Error while cleaning parent resource: %j', err);
        return callback(err);
      }
      resources = resources.concat(data.items);
      // Might need to recurse...
      if (data.items.length === pageSize) {
        console.log('Found more than one page of %s for resources.', pageSize);
        return collectResources(position);
      }
      continueWithCleanse();
    });
  }

  function continueWithCleanse() {
    console.log('Found batch of Resource objects: %j', resources);
    var parentPath = resources.filter(function(resource) {
      return resource.id === parentResourceId;
    })[0].path;
    var immediateChildResources = resources.filter(function(resource) {
      return resource.path !== '/' && resource.path.indexOf(parentPath) === 0 &&
        parentPath.replace(/^\//, '').split('/').length + 1 ===
          resource.path.split('/').length;
    });
    console.log('Found batch of immediate child Resource ' +
      'objects, commence deletion: %j', immediateChildResources);
    asyncMap(immediateChildResources.map(function(resource) {
      return deleteResource.bind(null, restApiId, resource.id);
    }), function(deleteAllErr, results) {
      if (deleteAllErr) {
        console.error('Error when deleting child resource set: %j', deleteAllErr);
        return callback(deleteAllErr);
      }
      console.log('Cleaned parent resource: %s', parentPath);
      callback(null, parentPath);
    });
  }
}

function deleteResource(restApiId, resourceId, callback) {
  APIG.deleteResource({
    restApiId: restApiId,
    resourceId: resourceId
  }, function(err, data) {
    if (err && err.statusCode !== 404) {
      console.log('Failed to delete resource: %j', err);
      return callback(err);
    }
    console.log('Initialized cleanse resource %s: %j', resourceId, data);
    waitFor404(restApiId, resourceId, callback);
  });
}

function waitFor404(restApiId, resourceId, callback) {
  console.log('Waiting for %s to actually delete...', resourceId);
  APIG.getResource({
    restApiId: restApiId,
    resourceId: resourceId
  }, function(err, data) {
    if (err && err.statusCode === 404) {
      console.log('Resource %s actually deleted.', resourceId);
      return callback();
    }
    if (err) {
      console.error('Fatal error while waiting for resource %s to delete.', resourceId);
      return callback(err);
    }
    setTimeout(function() {
      waitFor404(restApiId, resourceId, callback);
    }, 100);
  });
}

function asyncMap(actionSet, callback) {
  var results = [];
  var failed = false;
  var completed = 0;
  if (!actionSet.length) {
    return callback(null, []);
  }
  actionSet.forEach(function(action, index) {
    action(function(err, data) {
      if (failed) {
        return;
      }
      if (err) {
        failed = true;
        return callback(err);
      }
      results[index] = data;
      completed++;
      if (completed === actionSet.length) {
        callback(null, results);
      }
    });
  });
}

