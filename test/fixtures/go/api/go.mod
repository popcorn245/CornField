module example.test/pantry/api

go 1.23

require (
	example.test/pantry/shared v0.0.0
	example.test/pantry/tools v0.0.0 // required, never imported
	github.com/google/uuid v1.6.0
)

replace example.test/pantry/shared => ../shared
