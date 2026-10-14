# Vehicle asset

Tesla 2018 Model 3 by Ameer Studio.
[Original artist listing](https://sketchfab.com/3d-models/tesla-2018-model-3-5ef9b845aaf44203b6d04e2c677e444f).
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
[Download mirror and interaction reference](https://github.com/nesdesignco/FormDrive).

family-sedan.70259c87b911.glb is a derivative of the original self-contained asset. Seat upholstery
triangles were partitioned into Seat_Driver, Seat_Passenger and Seat_RearBench without
changing geometry, normals, UVs or textures. Each seat owns its vertex and index buffers.
Original source/licence metadata and a modification note are embedded in the GLB.

Runtime changes: crimson paint, neutral leather, glass transparency, realtime lighting,
door/window animations and airflow visualization. Plate meshes hidden. All car geometry
is rendered live; there are no pre-rendered car frames or videos.

Verified geometry: left-hand drive, 2 front seats, 3 rear positions with 3 headrests,
4 hinged doors and 4 separate windows. Vent visualization anchors are estimated from
model dash/console geometry; they are illustrative, not engineering airflow simulation.

See TESLA-LICENSE.md for artist credit.

The derivative is losslessly compressed with EXT_meshopt_compression (Meshoptimizer).
Unused original seat buffers were removed; active vertex attributes, triangle winding,
node hierarchy and transforms are preserved. Meshoptimizer licence: ../vendor/MESHOPT-LICENSE.md.
